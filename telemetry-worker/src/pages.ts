// HTML for https://genclass.dev/start (get a token) and https://genclass.dev/dashboard/<secret> (the dashboard), and
// the shell and dashboard the account pages (src/account-pages.ts) reuse: /account/apps/<id> is this dashboard in its
// account mode (the account's apps in the sidebar, the Connect panel, stats from the account API). Every plan includes
// the dashboard (billing/plans.json); a plan file that left it out would give the locked account mode (the key and
// the Connect panel, the plans, no stats), and a locked private link is account-pages.ts lockedLinkPage.
// No external scripts; styles and fonts only from Google Fonts. Inline <script>/<style> run under a per-response CSP
// nonce; dynamic text is inserted with textContent in scripts and escaped (esc) in server-rendered HTML.

/** The first @genclass/runtime that reads project keys (tokens) and has `login`; earlier versions ignore a key. */
export const KEY_RUNTIME = "0.3.0-beta.0";
/**
 * The runtime the snippets install, pinned in the script tag: the unversioned jsDelivr URL serves npm's `latest`
 * (0.2.x until 0.3.0, which ignores a key) and may serve an older release from the CDN cache. While it is a
 * prerelease, the npm and npx commands name its dist-tag (`@beta`): without it they install `latest`. At 0.3.0 set
 * SNIPPET_RUNTIME to "0.3.0" and RUNTIME_PKG to "@genclass/runtime" (and RUNTIME_ON_NPM in wrangler.toml), then deploy.
 */
export const SNIPPET_RUNTIME = "0.3.0-beta.0";
export const RUNTIME_PKG = "@genclass/runtime@beta";
export const CDN_SCRIPT = `https://cdn.jsdelivr.net/npm/@genclass/runtime@${SNIPPET_RUNTIME}`;
/** The first @genclass/runtime with the coding-agent link (`connectAgent`, `@genclass/runtime/agent`). */
export const AGENT_RUNTIME = "0.3.0-beta.1";
/** The AI agent view's commands (docs/runtime/AGENT.md section 1): @genclass/mcp in Claude Code. */
export const MCP_ADD = "claude mcp add genclass -- npx -y @genclass/mcp";
/** Where the page puts its own URL (location.origin + location.pathname, never a query or fragment) at runtime. */
export const MCP_DASHBOARD_PLACEHOLDER = "<this dashboard's URL>";
/** Private-link dashboards only: the same server, with GENCLASS_DASHBOARD for genclass_analytics `production`. */
export const MCP_ADD_DASHBOARD = `claude mcp add genclass -e GENCLASS_DASHBOARD=${MCP_DASHBOARD_PLACEHOLDER} -- npx -y @genclass/mcp`;
const AGENT_DOCS = "https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/AGENT.md";
/** What local and private hosts do, as the runtime behaves (src/telemetry/config.ts) and PRIVACY.md says. */
const LOCAL_HOSTS =
  "Local hosts (localhost, *.local, *.test and private networks) do not send by default, token or not; telemetry: true or a telemetry options object opts them in.";
/** Said first while the runtime that reads keys is not on npm yet (RUNTIME_ON_NPM, auth.ts runtimeHasTokens). */
const NOT_ON_NPM = `<b>Not on npm yet.</b> Project keys ship in @genclass/runtime ${KEY_RUNTIME} (npm dist-tag <code>beta</code>), which is not published yet: until it is, the script tag below does not load, <code>npx ${RUNTIME_PKG}</code> fails and 0.2.x ignores the key.`;

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
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' https://api.fontshare.com https://fonts.googleapis.com; font-src https://cdn.fontshare.com https://fonts.gstatic.com; connect-src 'self'; ` +
      `img-src 'self' data: https://genclass.dev; base-uri 'none'; form-action ${opts.account ? "'self'" : "'none'"}; frame-ancestors 'none'`,
    ...extra,
  };
}

/** HTML-escape text for element content and quoted attributes. */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** JSON safe to embed in <script type="application/json">. */
export const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** The header logo, as on genclass.dev: the mark and the name set in type. */
export const LOGO =
  '<a class="logo" href="https://genclass.dev/"><img src="https://genclass.dev/brand/mark-64.png?v=2" alt="" width="24" height="24">GenClass</a>';

/** The site's own icons (site/public/brand, apple-touch-icon.png), so every genclass.dev page shows the same one. */
const ICON_LINKS =
  '<link rel="icon" href="https://genclass.dev/brand/mark-32.png?v=2" sizes="32x32" type="image/png">' +
  '<link rel="icon" href="https://genclass.dev/brand/mark-64.png?v=2" sizes="64x64" type="image/png">' +
  '<link rel="apple-touch-icon" href="https://genclass.dev/apple-touch-icon.png">';

// The palette, type, buttons, header and focus ring of genclass.dev (site/src/css/base.css and components.css), with
// the site's values: black ground, bone text, the GenClass mark's green and red-orange, square corners, 1px rules,
// Satoshi for text and JetBrains Mono for code. Like the site, every page here is dark only, whatever the visitor's
// system theme: no prefers-color-scheme rules and `color-scheme: dark`, so form controls and scrollbars are dark too.
// The token names are the light design's (--paper is the page, --ink the text), so every rule keeps working. Text
// colours are at least 4.5:1 on --paper, --panel and --code, UI colours (focus ring, input border, fills) at least
// 3:1 (test/pages.test.ts measures them). --accent #2FD07F is the site's green for text, fills and buttons, with
// --on-green #02140A on it; --warn #FF6B4A the red-orange for bug text (the site's --bad), --warn-f #FF5A36 its bug
// fills; --accent-t and --warn-t are their tints on black. --line is an input border at 4:1 (the site's
// --rule-strong is 2:1, fine for a divider, not for an empty field).
const CSS = `
:root{
  --paper:#000000;--panel:#0B0B0A;--ink:#F0F1E9;--ink2:#A0A196;--ink3:#88897F;--rule:#30312B;--rule2:#46463E;--line:#6E6F66;
  --accent:#2FD07F;--accent-x:#2FD07F;--accent-f:#2FD07F;--accent-t:#06140D;--warn:#FF6B4A;--warn-f:#FF5A36;--warn-t:#1C0A06;
  --bar:#A0A196;--bar2:#2FD07F;--bar3:#FF5A36;--ink-h:#FFFFFF;--green-h:#52DA95;--on-green:#02140A;--head:rgba(0,0,0,.75);
  --code:#131311;--codeink:#F0F1E9;
  --display:"Satoshi",ui-sans-serif,system-ui,sans-serif;--sans:"Satoshi",ui-sans-serif,system-ui,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme:dark;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--paper)}
body{background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
::selection{background:var(--accent-f);color:var(--on-green)}
html:has(header.top){scroll-padding-top:76px}
a{color:inherit;text-underline-offset:3px}
:focus-visible{outline:1px solid var(--accent);outline-offset:3px}
.wrap{max-width:1240px;margin:0 auto;padding:0 clamp(16px,4vw,40px)}
header.top{position:sticky;top:0;z-index:20;background:var(--head);backdrop-filter:blur(24px) saturate(150%);-webkit-backdrop-filter:blur(24px) saturate(150%);border-bottom:1px solid var(--rule)}
@media (prefers-reduced-transparency:reduce){header.top{background:var(--paper)}}
header.top .wrap{display:flex;align-items:center;gap:22px;height:64px}
body:has(.app) header.top .wrap{max-width:1360px}
.logo{display:flex;align-items:center;gap:10px;flex:none;font:500 17px var(--display);letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.logo img{width:24px;height:24px;display:block}
header.top nav{margin-left:auto;display:flex;gap:22px;font-size:14px;color:var(--ink2);align-items:center}
header.top nav a{text-decoration:none;white-space:nowrap}
header.top nav a:not(.btn):hover,header.top nav .so button:hover,header.top nav a[aria-current=page]{color:var(--ink)}
header.top nav .btn{min-height:36px;font-size:14px;padding:0 14px}
header.top nav form.so{display:contents}
header.top nav .so button,button.lnk{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;white-space:nowrap}
@media (max-width:620px){header.top .wrap{gap:12px}header.top nav{gap:14px}header.top nav .hm{display:none}}
@media (max-width:420px){header.top nav .dc{display:none}}
@media (max-width:360px){header.top .wrap{gap:10px}}
h1,h2,h3{font-family:var(--display);text-wrap:balance}
h1{font-size:clamp(26px,4vw,40px);line-height:1.15;letter-spacing:-.04em;font-weight:500}
h2{font-size:17px;letter-spacing:-.015em;font-weight:500;margin-bottom:10px}
p.lead{color:var(--ink2);font-size:16px;max-width:62ch;margin-top:10px}
.muted{color:var(--ink3)}
.small{font-size:13px}
.mono{font-family:var(--mono)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 18px;border-radius:0;font:500 15px/1 var(--sans);cursor:pointer;border:1px solid var(--accent-f);background:var(--accent-f);color:var(--on-green);text-decoration:none;white-space:nowrap;transition:opacity .15s,border-color .15s,color .15s,transform .1s}
.btn:hover{opacity:.9}
.btn:active{transform:scale(.985)}
.btn:disabled{opacity:.6;cursor:progress}
.btn.green{background:var(--accent-f);border-color:var(--accent-f);color:var(--on-green)}
.btn.green:hover{opacity:.9}
.btn.ghost{background:transparent;color:var(--ink2);border-color:var(--rule2)}
.btn.ghost:hover{opacity:1;background:transparent;color:var(--ink);border-color:var(--ink3)}
.btn.sm{min-height:34px;padding:0 12px;font-size:13.5px}
@media (max-width:620px){.btn.sm{min-height:44px}}
input[type=text]{min-height:46px;padding:0 12px;border-radius:0;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:16px var(--sans);width:100%}
input[type=text]:focus-visible{outline:1px solid var(--accent);outline-offset:0;border-color:var(--accent)}
::placeholder{color:var(--ink3);opacity:1}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:0;padding:clamp(16px,3vw,28px);min-width:0}
.grid{display:grid;gap:12px}
.kpis{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.cols{grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.charts{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
@media (max-width:420px){.cols{grid-template-columns:1fr}}
.kpi .v{font-size:26px;font-weight:500;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.kpi .l{font-size:13px;color:var(--ink2)}
.kpi .s{font-size:12px;color:var(--ink3);margin-top:2px}
pre.code{background:var(--code);color:var(--codeink);border-radius:0;padding:12px 14px;font:13px/1.6 var(--mono);overflow-x:auto;white-space:pre}
.snip>*+*{margin-top:6px}
.snip .between{align-items:center}
.note{border:1px solid var(--rule);border-left:3px solid var(--warn);background:var(--panel);padding:12px 16px;border-radius:0;font-size:14px;color:var(--ink)}
.ok{border-left-color:var(--accent-f);background:var(--accent-t)}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--rule2);border-radius:0;padding:3px 10px;font:500 12px var(--mono);color:var(--ink2)}
.pill .dot{width:8px;height:8px;border-radius:50%;background:var(--ink3)}
.pill.live .dot{background:var(--accent-f)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tabs{display:inline-flex;border:1px solid var(--rule2);border-radius:0;overflow:hidden}
.tabs button{border:0;background:transparent;color:var(--ink2);padding:7px 12px;font:500 13px var(--sans);cursor:pointer}
.tabs button[aria-pressed=true]{background:var(--ink);color:var(--paper)}
.bars{list-style:none;display:grid;gap:6px}
.bars li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;font-size:13px}
.bars .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
.bars .n{font-variant-numeric:tabular-nums;color:var(--ink2)}
.bars .track{grid-column:1/-1;height:6px;border-radius:0;background:var(--rule)}
.bars .fill{height:6px;border-radius:0;background:var(--bar)}
.empty{color:var(--ink3);font-size:13px}
.chart svg{width:100%;height:120px;display:block}
.chart .axis{font-size:11px;color:var(--ink3);display:flex;justify-content:space-between;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--rule);white-space:nowrap}
th{color:var(--ink3);font:500 12px var(--mono);text-transform:uppercase;letter-spacing:.06em}
td.mono{font-family:var(--mono)}
.tablewrap{overflow-x:auto;padding-left:6px;margin-left:-6px}
section{margin-top:22px}
details summary{cursor:pointer;font-weight:500}
footer{margin:36px 0 28px;color:var(--ink3);font-size:13px}
.hidden{display:none!important}
.skip{position:absolute;left:12px;top:-60px;z-index:30;background:var(--accent-f);color:var(--on-green);padding:10px 14px;border-radius:0;font-size:14px;text-decoration:none}
.skip:focus{top:12px}
[tabindex="-1"]:focus{outline:none}
.field{display:grid;gap:6px;max-width:520px}
.field label{font-size:14px;font-weight:500}
.stack>*+*{margin-top:12px}
.mt-xl{margin-top:44px}.mt-l{margin-top:28px}.mt-s{margin-top:12px}.big{font-size:16px}.brk{word-break:break-all}.h2l{font-size:20px}.between{justify-content:space-between;align-items:flex-end}.minw0{min-width:0}
`;

const SNIPPETS_JS = `
// ep: this collector's own ingest URL when it is not genclass.dev's (a self-hosted collector, private mode). Then every
// snippet names it, through window.GENCLASS_CONFIG or GenClass.init (a meta tag may only name same-origin URLs), and
// the CLI's init, which makes its token at genclass.dev, is left out.
function snippets(tok, ep){
  var cfg = function(o){ return '<script>window.GENCLASS_CONFIG = { ' + o + 'telemetry: { endpoint: "' + ep + '" } };</' + 'script>'; };
  return [
    ["Easy: one script tag", "Paste into your HTML. GenClass starts itself and protects the whole app.",
     (ep ? cfg("") + "\\n" : "") + '<script src="${CDN_SCRIPT}" data-token="' + tok + '"></' + 'script>'],
    ["Easy: with a bundler", ep ? "One line in your HTML head plus one import (npm i ${RUNTIME_PKG})." : "A meta tag plus one import (npm i ${RUNTIME_PKG}).",
     ep ? "<!-- in your HTML <head> -->\\n" + cfg('token: "' + tok + '", ') + '\\n\\n// in your entry file\\nimport "@genclass/runtime/auto";'
        : '<meta name="genclass" content="token=' + tok + '">\\n\\n// in your entry file\\nimport "@genclass/runtime/auto";'],
    ["Function-specific", "Protect only the functions you choose; the dashboard shows each by name.",
     'import { GenClass, protect } from "@genclass/runtime";\\n\\nGenClass.init({ token: "' + tok + '", scope: "functions"' + (ep ? ', telemetry: { endpoint: "' + ep + '" }' : "") + ' });\\nconst save = protect("saveCart", saveCartImpl);']
  ].concat(ep ? [] : [["Automatic setup", "Run in your project folder: it detects your setup and wires GenClass (and a token) in for you.",
     'npx ${RUNTIME_PKG} init']]);
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
function renderSnippets(host, tok, ep){
  host.textContent = "";
  snippets(tok, ep || "").forEach(function(s){
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
  /** No top header: the sign-in pages put the logo at the top of their own column. */
  bare?: boolean;
  /** An account page: the referrer policy `same-origin` (see securityHeaders), which the meta tag must repeat. */
  account?: boolean;
  /** The id the "Skip to content" link jumps to (default the <main> element; pages with a sidebar name their content). */
  skip?: string;
  /**
   * A sign-in page: the content in a column on the left, the self-healing sphere of genclass.dev/signin-mesh.js (the
   * same backdrop as /admin's sign-in) on the right. The script is the site's, loaded under this page's nonce.
   */
  mesh?: boolean;
}

/** genclass.dev's sign-in backdrop script; bump ?v= with site/public/signin-mesh.js (assets are cached immutably). */
export const MESH_SCRIPT = "https://genclass.dev/signin-mesh.js?v=2";

/** As on genclass.dev: plain links, then one compact green button. Narrow screens drop Home (the logo links there),
 * then Docs. */
const DEFAULT_NAV =
  '<a class="hm" href="https://genclass.dev/">Home</a><a class="dc" href="https://genclass.dev/docs">Docs</a><a href="/login">Sign in</a><a class="btn" href="/start">Get a token</a>';

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
${ICON_LINKS}
<meta name="theme-color" content="#000000">
<link rel="preconnect" href="https://cdn.fontshare.com" crossorigin>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap">
<style nonce="${nonce}">${CSS}</style>
</head>
<body${opts.mesh ? ' class="mesh"' : ""}>
<a class="skip" href="#${esc(opts.skip ?? "main")}">Skip to content</a>
${header}<main class="wrap" id="main">${body}</main>
<script nonce="${nonce}">${SNIPPETS_JS}${script}</script>
${opts.mesh ? `<canvas data-mesh aria-hidden="true"></canvas>\n<script nonce="${nonce}" src="${MESH_SCRIPT}" defer></script>\n` : ""}</body>
</html>`;
}

/** Header links for a signed-in page: the apps, the docs, and a sign-out form (POST /logout, same-origin). */
export const SIGNED_IN_NAV =
  '<a href="/account">Apps</a><a href="https://genclass.dev/docs">Docs</a><form method="post" action="/logout" class="so"><button type="submit">Sign out</button></form>';

// ------------------------------------------------------------------------------------------------- /start

export function startPage(nonce: string, opts: { runtimeReady?: boolean; endpoint?: string | null } = {}): string {
  const notYet = opts.runtimeReady === true ? "" : `<p class="note small" id="notyet">${NOT_ON_NPM}</p>`;
  const body = `
<section class="stack mt-xl">
  <h1>Get a token for your web app</h1>
  <p class="lead">One token per app. Add it to GenClass and every page load, detection and fix is collected for the
  app's private dashboard. The dashboard is free.</p>
  <p class="muted small">To keep several apps in one place, <a href="/signup">create an account</a> or <a href="/login">sign in</a>.</p>
</section>
<section>
  <form id="f" class="card stack" novalidate>
    <div class="field"><label for="name">App name <span class="muted small">(optional, shown on your dashboard)</span></label>
    <input id="name" type="text" maxlength="80" autocomplete="off" placeholder="e.g. Acme checkout"></div>
    <div class="row"><button class="btn green" id="go" type="submit">Get a token</button><span id="err" class="small" role="alert"></span></div>
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
    It opens the dashboard, and lets you add the app to your account. Do not commit it to code.</div>
    <div class="row"><a id="dash" class="mono brk"></a><span id="dashc"></span></div>
    <div class="row"><a id="open" class="btn green" href="#">Open dashboard</a></div>
  </div>
  <div class="card stack"><h2 class="h2l">Install</h2>${notYet}<p class="muted small">The token needs @genclass/runtime ${KEY_RUNTIME} or later; earlier versions ignore it. ${LOCAL_HOSTS}</p><div id="snips" class="stack"></div></div>
</section>
<footer>Dashboards show counts only (never the situation text). Data is kept for 90 days.
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
        renderSnippets(document.getElementById("snips"), j.token, ${JSON.stringify(opts.endpoint ?? "")});
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
// The per-app dashboard: a one-sentence summary, four tiles, problems over time by type, sessions and the problem rate
// (Fig. 3: two line charts on one time axis, in the neutral --bar ink, one series each), one card per kind of
// problem (what it means, where it happened, how to fix it), pages, what GenClass did, model health, recent activity,
// and the AI agent view (@genclass/mcp setup).
// Chart colours come from genclass.dev's own hues, stepped into the dark chart lightness band (OKLCH L .48-.67): blue,
// the red-orange the site uses for bugs, a sky blue, amber (the site's warning colour) and violet, in that order (dark
// only, like the rest of the page). No green, which the brand keeps for "GenClass fixed it". Validated with the dataviz
// skill's validate_palette.js (adjacent pairs, as the stacks draw them) on 2026-10-17: on #000000 and #0B0B0A all
// checks pass, worst CVD ΔE 20.7 (deutan; tritan 7.3), normal-vision 24.8, every slot at least 3:1 on the surface (the
// light palette it replaces, on #FFFFFF: 20.0/31.3).
// A bar draws only the types it has, so slots that are not palette neighbours can touch; the 2px paper gap between
// segments, the legend, the hover breakdown and the table view carry identity there.
// Five problem types get a slot, the rest share "Other". Possible issues (the lower-confidence tier) are drawn hollow:
// outlined bars in the muted ink (Fig. 2, one series, so no legend) and ring keys in the type's colour; never in the
// confirmed counts.
// Every dynamic string goes through textContent.

export const DASH_CSS = `
:root{--t1:#3987E5;--t2:#E8552F;--t3:#2AA3C7;--t4:#C98500;--t5:#B964C9;--t0:#88897F;--grid:#1E1F1B}
h1,h2,h3{letter-spacing:-.03em}
.dh{margin-top:40px}
.dh-top{display:flex;flex-wrap:wrap;gap:20px;justify-content:space-between;align-items:flex-end}
.dh h1{font-size:clamp(30px,4.4vw,46px);font-weight:500;line-height:1.05}
.meta{font:12.5px var(--mono);color:var(--ink3);display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;margin-top:12px}
.live{display:inline-flex;align-items:center;gap:7px;color:var(--ink2)}
.live i{width:7px;height:7px;border-radius:50%;background:var(--ink3);display:inline-block}
.live.on i{background:var(--accent-f)}
.ctl{display:flex;gap:10px;align-items:center}
.seg{display:inline-flex;border:1px solid var(--rule2);border-radius:0;overflow:hidden}
.seg button{border:0;background:transparent;color:var(--ink);padding:8px 14px;font:500 13px var(--sans);cursor:pointer}
.seg button+button{border-left:1px solid var(--rule2)}
.seg button[aria-pressed=true]{background:var(--ink);color:var(--paper)}
.summary{margin-top:24px;font-size:clamp(18px,2.1vw,21px);line-height:1.5;max-width:68ch}
.summary b{font-weight:500}
.statrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));border-top:1px solid var(--rule2);margin-top:32px}
.statrow>div{padding:18px 20px 20px 0;border-bottom:1px solid var(--rule);min-width:0}
.statrow .k{font:500 12px var(--mono);color:var(--ink3)}
.statrow .v{font:500 40px/1.05 var(--display);letter-spacing:-.03em;margin-top:10px;font-variant-numeric:tabular-nums}
.statrow .s{font-size:13.5px;color:var(--ink2);margin-top:6px}
.blk{margin-top:60px}
.blk-h{display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--rule2)}
.blk-h h2{font-size:22px;font-weight:500;margin:0}
.blk-h .aside{font-size:13.5px;color:var(--ink3)}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;color:var(--ink2);margin-top:14px}
.legend span{display:inline-flex;align-items:center;gap:7px}
.key{width:8px;height:8px;border-radius:0;display:inline-block;flex:none}
.key.ring{background:transparent;border:1.5px solid var(--ink3)}
.poss-fig{margin-top:40px}
.poss-h{display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid var(--rule)}
.poss-h h3{font:500 17px var(--sans);letter-spacing:-.01em}
.poss-h .aside{font-size:13.5px;color:var(--ink3)}
.poss-note{font-size:14px;color:var(--ink2);margin-top:12px;max-width:72ch}
.mini-t{font:500 13px var(--sans);color:var(--ink2);margin-bottom:6px}
.plot svg+.mini-t{margin-top:18px}
.find.poss .n{font-weight:500;color:var(--ink2)}
table.dt td.poss-n{color:var(--ink3)}
figure{margin:0}
figcaption{font:12px var(--mono);color:var(--ink3);margin-top:12px}
.plot{position:relative;margin-top:14px}
.plot svg{display:block;width:100%;height:auto;overflow:visible}
.plot text{font:12px var(--mono);fill:var(--ink3)}
.tip{position:absolute;pointer-events:none;background:var(--panel);border:1px solid var(--rule2);border-radius:0;padding:9px 11px;font-size:13px;min-width:160px;z-index:2}
.tip .t{font:500 13px var(--sans);margin-bottom:5px}
.tip .r{display:flex;align-items:center;gap:8px;justify-content:space-between}
.tip .r span:first-child{display:inline-flex;align-items:center;gap:7px;color:var(--ink2)}
.tip .r b{font-variant-numeric:tabular-nums;font-weight:500}
.finds{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(330px,100%),1fr));column-gap:44px}
.find{padding:24px 0;border-bottom:1px solid var(--rule);display:grid;gap:11px;align-content:start;min-width:0}
.find .top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.find h3{font:500 17px var(--sans);letter-spacing:-.01em;display:flex;align-items:center;gap:9px}
.find .nw{text-align:right;white-space:nowrap}
.find .n{font:500 30px/1 var(--display);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.find .share{display:block;font:12px var(--mono);color:var(--ink3);margin-top:4px}
.find p{font-size:14.5px;color:var(--ink2)}
.find p.fix b{color:var(--ink);font-weight:500}
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
.mix i{display:block;height:6px;border-radius:0;min-width:3px}
.chip{display:inline-flex;align-items:center;gap:7px}
.did-a{color:var(--accent);font-weight:500}
dl.health{display:grid;grid-template-columns:minmax(150px,230px) minmax(0,1fr)}
dl.health dt,dl.health dd{padding:15px 0;border-bottom:1px solid var(--rule)}
dl.health dt{font:500 12.5px var(--mono);color:var(--ink3);padding-right:18px}
dl.health .v{font:500 18px var(--display);letter-spacing:-.01em}
dl.health .s{font-size:13.5px;color:var(--ink2);margin-top:3px}
dl.health ul{list-style:none;margin-top:6px;display:grid;gap:2px;font:12.5px var(--mono);color:var(--ink2)}
.ok-t{font:500 12.5px var(--mono);color:var(--accent);margin-left:8px}
.bad-t{font:500 12.5px var(--mono);color:var(--warn);margin-left:8px}
@media (max-width:560px){dl.health{grid-template-columns:1fr}dl.health dt{border-bottom:0;padding-bottom:0}}
.quiet{padding:36px 0;color:var(--ink3);font-size:14.5px}
details.more{border-top:1px solid var(--rule);padding:16px 0}
details.more summary{font:500 15px var(--sans);cursor:pointer}
.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px 40px}
.kv h2{font:500 14px var(--sans);margin-bottom:8px}
.first{border-top:1px solid var(--rule2);padding:22px 0;margin-top:32px;max-width:72ch}
.first p{font-size:15px;color:var(--ink2)}
.dfoot{margin:64px 0 36px;padding-top:18px;border-top:1px solid var(--rule);font-size:13px;color:var(--ink3);max-width:90ch}
.dfoot a{color:var(--ink2)}
main.wrap:has(.app){max-width:1360px}
.app{display:grid;grid-template-columns:232px minmax(0,1fr);gap:0 48px;align-items:start}
.side{position:sticky;top:65px;align-self:start;max-height:calc(100vh - 65px);overflow-y:auto;scrollbar-width:thin;padding:28px 24px 28px 16px;margin-left:-16px;border-right:1px solid var(--rule);min-height:calc(100vh - 65px)}
.side .proj{font:500 15px var(--sans);letter-spacing:-.01em;overflow-wrap:anywhere}
.side .proj small{display:block;font:12px var(--mono);color:var(--ink3);margin-top:4px;font-weight:400}
.side .live{margin-top:10px;font:12px var(--mono)}
.side .seg{margin-top:18px;display:flex;width:100%}
.side .seg button{flex:1;padding:7px 4px;font-size:12.5px}
.side .grp{font:500 11.5px var(--mono);color:var(--ink3);margin:26px 0 8px}
.side nav a{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 10px;margin:0 -10px;border-radius:0;font-size:14px;color:var(--ink2);text-decoration:none}
.side nav a:hover{color:var(--ink);background:var(--panel)}
.side nav a[aria-current=true]{color:var(--accent);background:var(--accent-t);font-weight:500}
.side nav a[aria-current=true] span{color:var(--accent)}
.side nav a span{font:12px var(--mono);color:var(--ink3);font-weight:400}
.side .out a{display:block;font-size:13.5px;color:var(--ink2);text-decoration:none;padding:5px 0}
.side .out a:hover{color:var(--ink)}
.side .btn{width:100%;margin-top:14px}
.side nav a[aria-current=page]{color:var(--ink);background:var(--panel);font-weight:500}
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
.connect h3{font:500 17px var(--sans);letter-spacing:-.01em}
.connect .way p{font-size:14.5px;color:var(--ink2);max-width:62ch}
.connect .sh{display:flex;justify-content:space-between;align-items:center;gap:10px;font:500 12px var(--mono);color:var(--ink3);margin-top:4px}
.connect pre.code{white-space:pre-wrap;overflow-wrap:anywhere}
.connect .cnote{margin-top:18px;padding:12px 0 12px 14px;border-left:3px solid var(--warn);font-size:14.5px;line-height:1.5;color:var(--ink2);max-width:80ch}
.connect .cnote b{color:var(--warn);font-weight:500}
.cstat{display:flex;align-items:center;gap:9px;padding:16px 0;font:500 13.5px var(--mono);color:var(--ink2);border-bottom:1px solid var(--rule2)}
.cstat i{width:8px;height:8px;border-radius:50%;background:var(--ink3);flex:none;animation:gcpulse 1.6s ease-in-out infinite}
.cstat.on{color:var(--accent)}
.cstat.on i{background:var(--accent-f);animation:none}
@keyframes gcpulse{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.cstat i{animation:none}}
.connect .fine{font-size:13px;color:var(--ink3);margin-top:14px;max-width:90ch}
@media (max-width:560px){.connect .keyrow{grid-template-columns:1fr}.connect .kn{grid-column:1}.connect .keyrow .k{padding-top:0;margin-bottom:6px}}
.agent .what{font-size:15.5px;color:var(--ink2);max-width:72ch;margin-top:18px}
.agent ul.asks{list-style:none;display:grid;gap:8px}
.agent ul.asks li{background:var(--code);color:var(--codeink);padding:10px 14px;font:13px/1.6 var(--mono);overflow-wrap:anywhere}
.mainc{min-width:0;padding-bottom:20px}
.lock{margin-top:28px;padding:22px 0;border-top:1px solid var(--rule2);border-bottom:1px solid var(--rule);max-width:72ch}
.lock h2{font:500 clamp(22px,3vw,28px)/1.15 var(--display);letter-spacing:-.02em;margin:0}
.lock p{font-size:16px;color:var(--ink2);margin-top:8px}
.lock .acts{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.lock .err{font-size:14px;color:var(--warn);margin-top:10px}
.lock .err:empty{display:none}
.mainc .dh{margin-top:32px}
/* views: the sidebar shows one view at a time (DASH_JS show()); without the script every section shows */
.vh{display:none!important}
.side nav.snav a{justify-content:flex-start}
.side nav.snav a span{margin-left:auto}
.snav a::before{content:"";width:16px;height:16px;flex:none;background:currentColor;opacity:.8;-webkit-mask:var(--ic) center/16px no-repeat;mask:var(--ic) center/16px no-repeat}
.snav a[href="#top"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Crect x=%223%22 y=%223%22 width=%227%22 height=%229%22 rx=%221%22/%3E%3Crect x=%2214%22 y=%223%22 width=%227%22 height=%225%22 rx=%221%22/%3E%3Crect x=%2214%22 y=%2212%22 width=%227%22 height=%229%22 rx=%221%22/%3E%3Crect x=%223%22 y=%2216%22 width=%227%22 height=%225%22 rx=%221%22/%3E%3C/svg%3E")}.snav a[href="#found"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z%22/%3E%3Cpath d=%22M12 9v4M12 17h.01%22/%3E%3C/svg%3E")}.snav a[href="#where"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z%22/%3E%3Cpath d=%22M14 2v6h6M16 13H8M16 17H8M10 9H8%22/%3E%3C/svg%3E")}.snav a[href="#did"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z%22/%3E%3Cpath d=%22m9 12 2 2 4-4%22/%3E%3C/svg%3E")}.snav a[href="#recent-s"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M22 12h-4l-3 9L9 3l-3 9H2%22/%3E%3C/svg%3E")}.snav a[href="#visits"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M9 9l5 12 1.8-5.2L21 14z%22/%3E%3Cpath d=%22M7.2 2.2 8 5.1M5.1 8l-2.9-.8M14 4.1 12 6M6 12l-1.9 2%22/%3E%3C/svg%3E")}.snav a[href="#health-s"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z%22/%3E%3C/svg%3E")}.snav a[href="#setup"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z%22/%3E%3C/svg%3E")}.snav a[href="#connect"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z%22/%3E%3C/svg%3E")}.snav a[href="#forwarding"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22m22 2-7 20-4-9-9-4z%22/%3E%3Cpath d=%22M22 2 11 13%22/%3E%3C/svg%3E")}.snav a[href="#export"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3%22/%3E%3C/svg%3E")}
.snav a[href="#agent"]{--ic:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23000%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22m4 17 6-6-6-6M12 19h8%22/%3E%3C/svg%3E")}
.crumbs{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font:12.5px var(--mono);color:var(--ink3);margin-bottom:10px}
.crumbs a{color:var(--ink2);text-decoration:none}
.crumbs a:hover{color:var(--ink)}
.dh .meta .btn{margin-left:4px}
@media (pointer:coarse){header.top{background:var(--paper);backdrop-filter:none;-webkit-backdrop-filter:none}}
@media (max-width:920px){
  .app{grid-template-columns:minmax(0,1fr)}
  .side{position:sticky;top:65px;z-index:5;max-height:none;min-height:0;overflow:visible;padding:10px 0;margin-left:0;border-right:0;border-bottom:1px solid var(--rule);background:var(--paper);display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
  .side .proj,.side .grp,.side .out,.side .live,.side .btn{display:none}
  .side .seg{margin-top:0;width:auto}
  .side .seg button{flex:none;padding:6px 10px}
  .side nav{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0}
  .side nav a{margin:0;white-space:nowrap;padding:6px 10px;font-size:13px}
  .side nav a span{display:none}
  .side nav.apps{display:none}
  html:has(.app>.side:not(.acct)){scroll-padding-top:125px}
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
  // distinct keys in the period (breakdown lists stop at their top 25)
  function count(S, m){ var d = S.distinct || {}; return d[m] != null ? d[m] : (S.breakdowns[m] || []).length; }
  function ring(color){ var s = el("span", "key ring"); s.style.borderColor = color; return s; }
  function issues(B, m){
    var out = {};
    (B[m || "detect_issue"] || []).forEach(function(x){
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
    var pages = count(S, "detect_route"), modes = map(B.mode), acting = (modes.guard || 0) + (modes.heal || 0) > 0, poss = T0.possible || 0;
    function put(t, bold){ host.appendChild(bold ? el("b", null, t) : document.createTextNode(t)); }
    if (!T0.sessions) { put("No page loads in this period yet."); return; }
    put(RANGE[S.range] + " GenClass watched "); put(plural(T0.sessions, "page load", "page loads"), true);
    if (!T0.detections && poss) { put(" and found no problems. It flagged "); put(plural(poss, "possible issue", "possible issues"), true); put(" at lower confidence, listed separately below."); return; }
    if (!T0.detections) { put(" and found nothing wrong. It only reports situations that stand out, so a quiet stretch is normal."); return; }
    put(" and found "); put(plural(T0.detections, "problem", "problems"), true);
    if (pages) { put(" on "); put(plural(pages, "page", "pages"), true); }
    put(". ");
    if (acting && T0.interventions) { put("It stepped in "); put(plural(T0.interventions, "time", "times"), true); var u = map(B.action_outcome).undone || 0; put(u ? ", and " + plural(u, "change was", "changes were") + " undone." : ", and nothing it changed was undone."); }
    else if (acting) put("It is allowed to step in and did not need to.");
    else put("It is in observe mode, so it reported them and changed nothing.");
    if (poss) { put(" It also flagged "); put(plural(poss, "possible issue", "possible issues"), true); put(" at lower confidence, listed separately and not counted as problems."); }
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
    var seenPages = count(S, "page_route");
    host.appendChild(stat("Pages affected", fmt(count(S, "detect_route")), seenPages ? "of " + plural(seenPages, "page", "pages") + " that sent data" : ""));
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
    var poss = {}, ptotal = 0;
    (S.series || []).forEach(function(b){ poss[b.bucket] = b.possible || 0; ptotal += b.possible || 0; });
    if (total || ptotal) trendTable(tbl, rows, order, hourly, poss, ptotal);
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
  }
  function trendTable(tbl, rows, order, hourly, poss, ptotal){
    var tb = el("table", "dt"), hr = el("tr"); hr.appendChild(el("th", null, hourly ? "Hour" : "Day")); order.forEach(function(s){ hr.appendChild(el("th", null, s === "other" ? "Other" : TYPES[s].name)); }); hr.appendChild(el("th", null, "Total"));
    if (ptotal) hr.appendChild(el("th", null, "Possible (not in total)"));
    var th = el("thead"); th.appendChild(hr); tb.appendChild(th); var body = el("tbody");
    rows.forEach(function(r){ var tr = el("tr"); tr.appendChild(el("td", null, label(r.bucket, hourly))); order.forEach(function(s){ tr.appendChild(el("td", null, fmt(r.parts[s] || 0))); }); tr.appendChild(el("td", null, fmt(r.total))); if (ptotal) tr.appendChild(el("td", "poss-n", fmt(poss[r.bucket] || 0))); body.appendChild(tr); });
    tb.appendChild(body); var wrap = el("div", "tablewrap"); wrap.appendChild(tb); tbl.appendChild(wrap);
  }
  // ---------- possible issues over time (Fig. 2): one series, hollow bars in the muted ink, its own axis
  function possibleTrend(S){
    var host = document.getElementById("possplot"), fig = document.getElementById("possfig"); host.textContent = "";
    var hourly = S.range === "24h", rows = (S.series || []).map(function(b){ return { bucket: b.bucket, n: b.possible || 0 }; });
    var total = rows.reduce(function(s, r){ return s + r.n; }, 0);
    document.getElementById("unit2").textContent = hourly ? "hour" : "day";
    document.getElementById("possn").textContent = plural(total, "possible issue", "possible issues");
    fig.classList.toggle("hidden", !total);
    if (!total) return;
    var W = 720, H = 120, PL = 30, PB = 24, PT = 6, n = rows.length, plotW = W - PL, plotH = H - PB - PT;
    var max = niceMax(Math.max.apply(null, rows.map(function(r){ return r.n; })));
    var g = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Possible issues (lower confidence) per " + (hourly ? "hour" : "day") });
    [0, max].forEach(function(v){
      var y = PT + plotH - plotH * v / max;
      g.appendChild(svg("line", { x1: PL, x2: W, y1: y, y2: y, stroke: v ? "var(--grid)" : "var(--rule2)", "stroke-width": 1 }));
      var t = svg("text", { x: PL - 6, y: y + 4, "text-anchor": "end" }); t.textContent = fmt(v); g.appendChild(t);
    });
    var step = plotW / n, bw = Math.max(2, Math.min(28, step * 0.64)), tip = el("div", "tip hidden");
    rows.forEach(function(r, i){
      var x = PL + i * step + (step - bw) / 2;
      if (r.n) { var h = Math.max(2, plotH * r.n / max); g.appendChild(svg("rect", { x: x + 0.75, y: PT + plotH - h + 0.75, width: Math.max(1, bw - 1.5), height: h - 0.75, rx: 2, fill: "var(--panel)", stroke: "var(--ink3)", "stroke-width": 1.5 })); }
      if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
        var lt = svg("text", { x: PL + i * step + step / 2, y: H - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }); lt.textContent = label(r.bucket, hourly); g.appendChild(lt);
      }
      var hit = svg("rect", { x: PL + i * step, y: PT, width: step, height: plotH, fill: "transparent", tabindex: 0 });
      function show(){
        tip.textContent = ""; tip.appendChild(el("div", "t", label(r.bucket, hourly) + ": " + plural(r.n, "possible issue", "possible issues")));
        var row = el("div", "r"), a = el("span"); a.appendChild(ring("var(--ink3)")); a.appendChild(document.createTextNode("Not counted as problems")); row.appendChild(a); tip.appendChild(row);
        tip.classList.remove("hidden");
        var box = host.getBoundingClientRect(), left = (PL + i * step + step / 2) / W * box.width;
        tip.style.left = Math.min(Math.max(0, left - 80), box.width - 170) + "px"; tip.style.top = "0px";
      }
      hit.addEventListener("mouseenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", function(){ tip.classList.add("hidden"); }); hit.addEventListener("blur", function(){ tip.classList.add("hidden"); });
      g.appendChild(hit);
    });
    host.appendChild(g); host.appendChild(tip);
  }

  // ---------- sessions and problem rate (Fig. 3): two small line charts on one time axis, never one chart with two
  // y axes. The rate is detections / sessions * 1000; a bucket with no sessions has no rate (a gap, not a zero).
  var nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }), nfc = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  function yTick(v){ return v >= 10000 ? nfc.format(v) : nf1.format(v); }
  function rateTrend(S){
    var host = document.getElementById("rateplot"), tbl = document.getElementById("ratetable"), aside = document.getElementById("raten");
    host.textContent = ""; tbl.textContent = ""; aside.textContent = "";
    var hourly = S.range === "24h", unit = hourly ? "hour" : "day";
    [].forEach.call(document.querySelectorAll(".unit3"), function(u){ u.textContent = unit; });
    var rows = (S.series || []).map(function(b){
      var s = b.sessions || 0, d = b.detections || 0;
      return { bucket: b.bucket, s: s, d: d, r: s > 0 ? 1000 * d / s : null };
    });
    var ts = rows.reduce(function(a, r){ return a + r.s; }, 0), td = rows.reduce(function(a, r){ return a + r.d; }, 0);
    if (!ts) { host.appendChild(el("p", "quiet", "No sessions in this period, so there is nothing to draw.")); return; }
    aside.textContent = plural(ts, "session", "sessions") + ", " + nf1.format(1000 * td / ts) + " problems per 1,000";
    var tb = el("table", "dt"), hr = el("tr");
    [hourly ? "Hour" : "Day", "Sessions", "Problems", "Per 1,000 sessions"].forEach(function(h, i){ hr.appendChild(el("th", i ? "num" : null, h)); });
    var thd = el("thead"); thd.appendChild(hr); tb.appendChild(thd); var body = el("tbody");
    rows.forEach(function(r){
      var tr = el("tr"); tr.appendChild(el("td", null, label(r.bucket, hourly))); tr.appendChild(el("td", "num", fmt(r.s))); tr.appendChild(el("td", "num", fmt(r.d)));
      tr.appendChild(el("td", "num", r.r == null ? "-" : nf1.format(r.r))); body.appendChild(tr);
    });
    tb.appendChild(body); var wrap = el("div", "tablewrap"); wrap.appendChild(tb); tbl.appendChild(wrap);
    var W = 720, PL = 30, PT = 8, n = rows.length, step = (W - PL) / n, tip = el("div", "tip hidden"), charts = [];
    function xAt(i){ return PL + i * step + step / 2; }
    function point(i){
      var r = rows[i], x = xAt(i);
      charts.forEach(function(c){
        c.cross.setAttribute("x1", x); c.cross.setAttribute("x2", x); c.cross.setAttribute("visibility", "visible");
        var v = c.vals[i];
        if (v == null) c.dot.setAttribute("visibility", "hidden");
        else { c.dot.setAttribute("cx", x); c.dot.setAttribute("cy", c.yAt(v)); c.dot.setAttribute("visibility", "visible"); }
      });
      tip.textContent = ""; tip.appendChild(el("div", "t", label(r.bucket, hourly)));
      [["Sessions", fmt(r.s)], ["Problems", fmt(r.d)], ["Per 1,000 sessions", r.r == null ? "no sessions" : nf1.format(r.r)]].forEach(function(p){
        var row = el("div", "r"); row.appendChild(el("span", null, p[0])); row.appendChild(el("b", null, p[1])); tip.appendChild(row);
      });
      tip.classList.remove("hidden");
      // beside the crosshair, so the highlighted points stay in view
      var box = host.getBoundingClientRect(), left = x / W * box.width, tw = tip.offsetWidth || 180, at = left + 14;
      if (at + tw > box.width) at = left - 14 - tw;
      tip.style.left = Math.max(0, at) + "px"; tip.style.top = "0px";
    }
    function unpoint(){
      tip.classList.add("hidden");
      charts.forEach(function(c){ c.cross.setAttribute("visibility", "hidden"); c.dot.setAttribute("visibility", "hidden"); });
    }
    // one small chart: a single series (the title above names it), y from 0, its own nice ticks; only the top chart's
    // buckets take keyboard focus (focus shows the crosshair in both), only the bottom one carries the x labels
    function chart(title, aria, vals, H, PB, xlabels, keys){
      var plotH = H - PB - PT, max = niceMax(Math.max.apply(null, vals.filter(function(v){ return v != null; }).concat([0])));
      function yAt(v){ return PT + plotH - plotH * v / max; }
      host.appendChild(el("div", "mini-t", title));
      var g = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": aria });
      [0, max / 2, max].forEach(function(v){
        var y = yAt(v);
        g.appendChild(svg("line", { x1: PL, x2: W, y1: y, y2: y, stroke: v ? "var(--grid)" : "var(--rule2)", "stroke-width": 1 }));
        var t = svg("text", { x: PL - 6, y: y + 4, "text-anchor": "end" }); t.textContent = yTick(v); g.appendChild(t);
      });
      // the line breaks at a missing value; a point with no neighbours is a zero-length segment (a round dot)
      var d = "";
      vals.forEach(function(v, i){
        if (v == null) return;
        var lone = (i === 0 || vals[i - 1] == null) && (i === n - 1 || vals[i + 1] == null);
        d += (i === 0 || vals[i - 1] == null ? "M" : "L") + xAt(i).toFixed(1) + " " + yAt(v).toFixed(1) + (lone ? "h0" : "");
      });
      if (d) g.appendChild(svg("path", { d: d, fill: "none", stroke: "var(--bar)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }));
      if (xlabels) rows.forEach(function(r, i){
        if (i !== 0 && i !== n - 1 && i !== Math.floor(n / 2)) return;
        var lt = svg("text", { x: xAt(i), y: H - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }); lt.textContent = label(r.bucket, hourly); g.appendChild(lt);
      });
      var cross = svg("line", { x1: 0, x2: 0, y1: PT, y2: PT + plotH, stroke: "var(--ink3)", "stroke-width": 1, visibility: "hidden", "pointer-events": "none" });
      var dot = svg("circle", { cx: 0, cy: 0, r: 4, fill: "var(--bar)", stroke: "var(--paper)", "stroke-width": 2, visibility: "hidden", "pointer-events": "none" });
      g.appendChild(cross); g.appendChild(dot);
      rows.forEach(function(r, i){
        var a = { x: PL + i * step, y: PT, width: step, height: plotH, fill: "transparent" };
        if (keys) a.tabindex = 0;
        var hit = svg("rect", a);
        hit.addEventListener("mouseenter", function(){ point(i); }); hit.addEventListener("mouseleave", unpoint);
        if (keys) { hit.addEventListener("focus", function(){ point(i); }); hit.addEventListener("blur", unpoint); }
        g.appendChild(hit);
      });
      host.appendChild(g);
      charts.push({ cross: cross, dot: dot, vals: vals, yAt: yAt });
    }
    chart("Sessions per " + unit, "Sessions per " + unit, rows.map(function(r){ return r.s; }), 120, 8, false, true);
    chart("Problems per 1,000 sessions", "Problems found per 1,000 sessions, per " + unit + "; no value where there were no sessions", rows.map(function(r){ return r.r; }), 140, 24, true, false);
    host.appendChild(tip);
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
  // the lower-confidence tier: its own cards (ring keys), never merged into the ones above
  function possibleCards(S){
    var B = S.breakdowns, host = document.getElementById("possible"), byIssue = issues(B, "possible_issue"); host.textContent = "";
    var list = (B.possible_diagnosis || []).filter(function(x){ return x.key !== "expected"; }), total = sum(list);
    document.getElementById("possible-s").classList.toggle("hidden", !list.length);
    list.forEach(function(x){
      var t = T(x.key), c = el("article", "find poss");
      var top = el("div", "top"), h = el("h3"); h.appendChild(ring(colorOf(slotOf(x.key)))); h.appendChild(document.createTextNode(t.name)); top.appendChild(h);
      var nw = el("div", "nw"); nw.appendChild(el("span", "n", fmt(x.count))); nw.appendChild(el("span", "share", total ? Math.round(100 * x.count / total) + "% of possible issues" : "")); top.appendChild(nw); c.appendChild(top);
      if (t.what) c.appendChild(el("p", null, t.what));
      var where = (byIssue[x.key] || []).slice().sort(function(a, b){ return b.count - a.count; });
      if (where.length) {
        var ul = el("ul", "where");
        where.slice(0, 4).forEach(function(w){ var li = el("li"); li.appendChild(el("code", null, w.route)); li.appendChild(el("span", null, fmt(w.count))); ul.appendChild(li); });
        c.appendChild(ul);
      }
      host.appendChild(c);
    });
  }

  // ---------- pages, actions, health
  function pages(S){
    var B = S.breakdowns, T0 = S.totals, host = document.getElementById("pages"), byIssue = issues(B), byPoss = issues(B, "possible_issue"); host.textContent = "";
    var routes = {};
    function at(route){ return routes[route] = routes[route] || { route: route, total: 0, parts: {}, poss: 0 }; }
    Object.keys(byIssue).forEach(function(d){ byIssue[d].forEach(function(w){ var r = at(w.route); var s = slotOf(d); r.parts[s] = (r.parts[s] || 0) + w.count; r.total += w.count; }); });
    if (!Object.keys(routes).length) (B.detect_route || []).forEach(function(x){ at(x.key).total += x.count; });
    if (Object.keys(byPoss).length) Object.keys(byPoss).forEach(function(d){ byPoss[d].forEach(function(w){ at(w.route).poss += w.count; }); });
    else (B.possible_route || []).forEach(function(x){ at(x.key).poss += x.count; });
    var list = Object.keys(routes).map(function(k){ return routes[k]; });
    list.sort(function(a, b){ return b.total - a.total || b.poss - a.poss; });
    if (!list.length) { host.appendChild(el("p", "quiet", "No problems on any page in this period.")); return; }
    var anyPoss = list.some(function(r){ return r.poss; });
    var max = list[0].total || 1, tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
    hr.appendChild(el("th", null, "Page")); hr.appendChild(el("th", "num", "Problems")); hr.appendChild(el("th", null, "By type"));
    if (anyPoss) hr.appendChild(el("th", "num", "Possible"));
    hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
    list.slice(0, 8).forEach(function(r){
      var tr = el("tr"); var rc = el("td", "route", r.route); rc.title = r.route; tr.appendChild(rc); tr.appendChild(el("td", "num", fmt(r.total)));
      var td = el("td", "wide"), mix = el("div", "mix"), parts = SLOTS.concat(["other"]).filter(function(s){ return r.parts[s]; });
      if (!parts.length && r.total) { var i0 = el("i"); i0.style.width = (100 * r.total / max) + "%"; i0.style.background = "var(--t0)"; i0.title = "Not broken down by type: " + fmt(r.total); mix.appendChild(i0); }
      parts.forEach(function(s){ var i = el("i"); i.style.width = (100 * r.parts[s] / max) + "%"; i.style.background = colorOf(s); i.title = (s === "other" ? "Other" : TYPES[s].name) + ": " + fmt(r.parts[s]); mix.appendChild(i); });
      td.appendChild(mix); tr.appendChild(td);
      if (anyPoss) tr.appendChild(el("td", "num poss-n", r.poss ? fmt(r.poss) : "-"));
      body.appendChild(tr);
    });
    tb.appendChild(body); host.appendChild(tb);
    var notes = [], withPage = T0.detectionsWithPage;
    if (anyPoss) notes.push("Possible: lower-confidence issues on that page, not counted in Problems.");
    if (typeof withPage === "number" && T0.detections > withPage) notes.push(plural(T0.detections - withPage, "problem", "problems") + " arrived without a page (the page comes with the decision record, which was in another batch or not sent); the totals count them.");
    var possWithPage = T0.possibleWithPage;
    if (anyPoss && typeof possWithPage === "number" && (T0.possible || 0) > possWithPage) notes.push(plural(T0.possible - possWithPage, "possible issue", "possible issues") + " arrived without a page.");
    if (notes.length) host.appendChild(el("figcaption", null, notes.join(" ")));
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
    // from the decision records that arrived: routine ones are sampled (0.3.0), so the average leans towards the rest
    var sampled = (T0.records_sampled_out || 0) + (T0.records_capped || 0) > 0;
    row(dl, "Decision time", T0.latency_ms_n ? fmt(T0.latencyAvgMs) + " ms" : "-", T0.latency_ms_n ? "average of " + plural(T0.latency_ms_n, "decision record", "decision records") + " received" + (sampled ? "; routine decisions are sampled, so it leans towards the others" : "") : "no decisions yet");
    row(dl, "Ran without a decision", fmt(T0.failOpens), "times the app went ahead without a decision (model not ready, budget, hidden tab)", T0.failOpens ? null : ["ok", "none"]);
    var hs = T0.hidden_skipped || 0, md = T0.model_dropped || 0;
    row(dl, "Not checked", fmt(hs + md), hs + md ? [hs ? fmt(hs) + " in hidden tabs" : "", md ? fmt(md) + " over the decision rate limit" : ""].filter(Boolean).join(", ") : "situations skipped in hidden tabs or over the decision rate limit", hs + md ? null : ["ok", "none"]);
    if (T0.actionLimits) row(dl, "Action limits reached", fmt(T0.actionLimits), "times GenClass ran the passive action because an action limit was reached");
    var so = T0.records_sampled_out || 0, rc = T0.records_capped || 0, td = T0.telemetry_dropped || 0;
    if (so + rc + td) row(dl, "Records not sent", fmt(so + rc + td), [so ? fmt(so) + " routine decisions sampled out" : "", rc ? fmt(rc) + " over the per-page cap" : "", td ? fmt(td) + " dropped in the browser" : ""].filter(Boolean).join(", ") + ". The totals above still count every decision and detection; pages and functions come from the records that arrived.");
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
    [["Triggers", B.trigger], ["Diagnoses (all decisions)", B.diagnosis], ["Top routes (decision records)", B.route], ["Top pages (page loads)", B.page_route], ["Protected functions", B.fn],
     ["Model load states", B.model_state], ["Decision latency (records)", B.latency_bucket], ["Fail-opens (reason:trigger)", B.fail_open], ["Modes", B.mode], ["Model versions", B.model_version],
     ["Hosts seen", B.host], ["Possible issues (lower confidence)", B.possible_diagnosis], ["Action limits", B.action_limits]].forEach(function(p){
      var c = el("div"); c.appendChild(el("h2", null, p[0]));
      if (!p[1] || !p[1].length) { c.appendChild(el("p", "empty", "None in this period.")); host.appendChild(c); return; }
      var max = Math.max.apply(null, p[1].map(function(x){ return x.count; })) || 1, ul = el("ul", "bars");
      p[1].slice(0, 10).forEach(function(x){ var li = el("li"); var k = el("span", "k", x.key); k.title = x.key; li.appendChild(k); li.appendChild(el("span", "n", fmt(x.count))); var tr = el("span", "track"); var fi = el("span", "fill"); fi.style.display = "block"; fi.style.width = Math.max(2, 100 * x.count / max) + "%"; tr.appendChild(fi); li.appendChild(tr); ul.appendChild(li); });
      c.appendChild(ul); host.appendChild(c);
    });
  }

  // ---------- interaction analytics (runtime \`interactions\` events: only apps that turned them on)
  function dur(ms){
    var s = Math.round((ms || 0) / 1000);
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min" + (s % 60 ? " " + (s % 60) + " s" : "");
    return (s / 3600).toFixed(1) + " h";
  }
  function pairs(list){ return (list || []).map(function(x){ var i = x.key.indexOf("\\t"); return i < 0 ? null : { route: x.key.slice(0, i), key: x.key.slice(i + 1), count: x.count }; }).filter(Boolean); }
  function ixTable(host, list, head, empty){
    host.textContent = "";
    if (!list.length) { host.appendChild(el("p", "quiet", empty)); return; }
    var max = list[0].count || 1, tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
    hr.appendChild(el("th", null, "Page")); hr.appendChild(el("th", null, "Element")); hr.appendChild(el("th", "num", head)); hr.appendChild(el("th", null, ""));
    hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
    list.slice(0, 10).forEach(function(x){
      var tr = el("tr"), rc = el("td", "route", x.route); rc.title = x.route; tr.appendChild(rc);
      var kc = el("td", "route", x.key); kc.title = x.key; tr.appendChild(kc);
      tr.appendChild(el("td", "num", fmt(x.count)));
      var td = el("td", "wide"), mix = el("div", "mix"), i = el("i"); i.style.width = (100 * x.count / max) + "%"; i.style.background = "var(--accent-f)"; mix.appendChild(i); td.appendChild(mix); tr.appendChild(td);
      body.appendChild(tr);
    });
    tb.appendChild(body); host.appendChild(tb);
  }
  function visits(S){
    var B = S.breakdowns, T0 = S.totals, views = T0.ix_views || 0, on = views > 0 || (B.ix_click || []).length > 0;
    ["visits", "clicks", "nav-visits"].forEach(function(id){ var e = document.getElementById(id); if (e) e.classList.toggle("hidden", !on); });
    if (!on) return;
    var dl = el("dl", "health"), prev = (S.previous || {}).ix_views;
    row(dl, "Page views", fmt(views), typeof prev === "number" && prev ? (views >= prev ? "+" : "") + share(views - prev, prev) + " on the previous period" : "page loads and in-app route changes");
    row(dl, "Time on page", views ? dur((T0.ix_engaged_ms || 0) / views) : "-", "average engaged time per view: the tab visible, at most 30 s after the last input");
    row(dl, "Clicks", fmt(T0.ix_click || 0), views ? (Math.round(10 * (T0.ix_click || 0) / views) / 10) + " per view" : "");
    row(dl, "Rage clicks", fmt(T0.ix_rage || 0), "3 or more clicks on one element within a second", T0.ix_rage ? ["bad", "worth a look"] : ["ok", "none"]);
    row(dl, "Dead clicks", fmt(T0.ix_dead || 0), "a link or button that changed nothing within a second", T0.ix_dead ? ["bad", "worth a look"] : ["ok", "none"]);
    var sumh = document.getElementById("ixsum"); sumh.textContent = ""; sumh.appendChild(dl);
    sumh.appendChild(el("figcaption", null, "Unique visitors are not counted: GenClass stores no visitor id, so two page loads by one person cannot be linked."));
    var eng = map(B.ix_engaged_ms), reach = {};
    pairs(B.ix_scroll).forEach(function(x){ (reach[x.route] = reach[x.route] || {})[x.key] = x.count; });
    var host = document.getElementById("ixpages"); host.textContent = "";
    var list = (B.ix_views || []).slice().sort(function(a, b){ return b.count - a.count; });
    if (!list.length) return;
    var tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
    ["Page", "Views", "Time on page", "Read half", "Read to the end"].forEach(function(h, i){ hr.appendChild(el("th", i ? "num" : null, h)); });
    hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
    list.slice(0, 12).forEach(function(x){
      var tr = el("tr"), rc = el("td", "route", x.key); rc.title = x.key; tr.appendChild(rc);
      var r = reach[x.key] || {};
      tr.appendChild(el("td", "num", fmt(x.count)));
      tr.appendChild(el("td", "num", x.count ? dur((eng[x.key] || 0) / x.count) : "-"));
      tr.appendChild(el("td", "num", share(Math.min(r["50"] || 0, x.count), x.count)));
      tr.appendChild(el("td", "num", share(Math.min(r["100"] || 0, x.count), x.count)));
      body.appendChild(tr);
    });
    tb.appendChild(body); host.appendChild(tb);
    host.appendChild(el("figcaption", null, "Table 4. Pages by views. Read half / to the end: the share of views whose viewport reached 50 % / 100 % of the page height."));
    ixTable(document.getElementById("ixclicks"), pairs(B.ix_click), "Clicks", "No clicks recorded in this period.");
    var flags = pairs(B.ix_rage).map(function(x){ return { route: x.route, key: x.key + "  (rage)", count: x.count }; })
      .concat(pairs(B.ix_dead).map(function(x){ return { route: x.route, key: x.key + "  (dead)", count: x.count }; }))
      .sort(function(a, b){ return b.count - a.count; });
    ixTable(document.getElementById("ixflags"), flags, "Clicks", "No rage or dead clicks in this period.");
    document.getElementById("c-visits").textContent = fmt(views);
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
    summary(S); tiles(S); trend(S); possibleTrend(S); rateTrend(S); cards(S); possibleCards(S); pages(S); acted(S); health(S); recent(S); visits(S); advanced(S);
    var B2 = S.breakdowns, T2 = S.totals;
    document.getElementById("c-trend").textContent = fmt(T2.detections);
    document.getElementById("c-found").textContent = String((B2.detect_diagnosis || []).filter(function(x){ return x.key !== "expected"; }).length);
    document.getElementById("c-pages").textContent = String(count(S, "detect_route"));
    document.getElementById("c-did").textContent = fmt(T2.interventions);
  }

  document.getElementById("pname").textContent = P.name;
  document.getElementById("sname").textContent = P.name;
  var crumb = document.getElementById("crumb"); if (crumb) crumb.textContent = P.name;
  // Views: each sidebar link opens one view (the sections marked data-v with it); the header stays. The hash names
  // the link, so a view can be linked to and the back button works. While an app waits for its first event the view
  // is Connect.
  (function(){
    var VIEW = { top: "overview", trend: "overview", rate: "overview", agent: "agent", found: "problems", where: "pages", did: "pages", "recent-s": "activity", visits: "visitors", "health-s": "health", connect: "connect", setup: "setup", forwarding: "forwarding", "export": "export" };
    var links = [].slice.call(document.querySelectorAll(".snav a"));
    var parts = [].slice.call(document.querySelectorAll("[data-v]"));
    function show(id, jump){
      var v = VIEW[id];
      if (!v || !parts.some(function(s){ return s.getAttribute("data-v") === v; })) return false;
      if (id === "setup") { var d = document.getElementById("install"); if (d) d.open = true; }
      if (id === "connect") { var cn = document.getElementById("connect"); if (cn) cn.classList.remove("hidden"); }
      parts.forEach(function(s){ s.classList.toggle("vh", s.getAttribute("data-v") !== v); });
      var cur = links.filter(function(a){ return a.getAttribute("href") === "#" + id; })[0] || links.filter(function(a){ return VIEW[a.getAttribute("href").slice(1)] === v; })[0];
      links.forEach(function(a){ a.setAttribute("aria-current", String(a === cur)); });
      // the breadcrumb ends with the view's name (the link's label, without its count)
      var cv = document.getElementById("crumbv");
      if (cv) cv.textContent = cur && v !== "overview" ? " / " + (cur.firstChild && cur.firstChild.nodeType === 3 ? cur.firstChild.nodeValue : cur.textContent).trim() : "";
      if (jump) { var t = document.getElementById(id); if (id === "did" && t) t.scrollIntoView(); else window.scrollTo(0, 0); }
      return true;
    }
    function go(e, id){
      if (!show(id, true)) return;
      if (e) e.preventDefault();
      try { history.replaceState(null, "", "#" + id); } catch (x) {}
    }
    links.concat([].slice.call(document.querySelectorAll("a[data-goto]"))).forEach(function(a){
      a.addEventListener("click", function(e){ go(e, a.getAttribute("data-goto") || a.getAttribute("href").slice(1)); });
    });
    window.addEventListener("hashchange", function(){ show(location.hash.slice(1), true); });
    var per = document.getElementById("period");
    var first = location.hash.slice(1);
    if (!show(first, false)) show(per && per.classList.contains("hidden") ? "connect" : "top", false);
  })();
  document.title = P.name + " | GenClass dashboard";
  // the AI agent view: copy buttons, and on a private link the command that names this dashboard, filled in from the
  // page's own URL (origin and path only: never a query or fragment)
  (function(){
    var ag = document.getElementById("agent"); if (!ag) return;
    var dc = document.getElementById("asnipd"), db = document.getElementById("asnipdb");
    if (dc && db) {
      // the server rendered the command with its placeholder (private links only, so account pages never carry it)
      var url = location.origin + location.pathname, cmd = dc.textContent.replace(${embed(MCP_DASHBOARD_PLACEHOLDER)}, function(){ return url; });
      dc.textContent = cmd; db.setAttribute("data-copy", cmd);
    }
    ag.querySelectorAll("[data-copy]").forEach(function(b){
      b.addEventListener("click", function(){
        var at = b.getAttribute("data-target");
        gcCopy(b, b.getAttribute("data-copy"), at ? document.getElementById(at) : null);
      });
    });
  })();
  if (document.getElementById("ptok")) {
    document.getElementById("ptok").textContent = P.token;
    document.getElementById("ptokc").appendChild(copyBtn(function(){ return P.token; }, "token", function(){ return document.getElementById("ptok"); }));
    renderSnippets(document.getElementById("snips"), P.token, P.endpoint || "");
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
  /** This collector's own ingest URL when it is self-hosted (ownEndpoint): the snippets name it. */
  endpoint?: string | null;
  /** Owned-app mode (/account/apps/<id>): the account's apps in the sidebar, the Connect panel, account stats API. */
  account?: { apps: { id: string; name: string }[]; current: string; email: string | null };
  /** The project's id (account mode). */
  id?: string;
  /** When the app's first batch arrived (account mode; null while waiting). */
  firstEvent?: string | null;
  /** Account mode: whether the app's private dashboard link still opens these stats (the footer says so). */
  privateLink?: boolean;
  /**
   * Whether a @genclass/runtime that reads project keys (KEY_RUNTIME or later, any dist-tag) is on npm (RUNTIME_ON_NPM);
   * until then the Connect panel, and the setup notes of a private-link dashboard, say so first.
   */
  runtimeReady?: boolean;
  /** Account mode: the time ranges the account's plan shows (src/plans.ts); default 24 h, 7 and 30 days. */
  ranges?: string[];
  /** Account mode: how many days the plan keeps this app's data (the footer says it); default 90. */
  keepDays?: number;
  /** Account mode: plan-dependent sections (forwarding, export; src/billing-pages.ts) and their script. */
  extra?: { html: string; script: string };
  /**
   * Account mode, locked: the account's plan has no dashboard (a plan file without it; none today). The page keeps
   * the app's key and the Connect panel and links the plans; no stats are loaded.
   */
  locked?: boolean;
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

/**
 * This collector's own ingest URL when it is not genclass.dev's: a collector self-hosted from wrangler.selfhost.toml
 * (private mode), or `wrangler dev`. Its snippets then name it, or the pages would send to genclass.dev.
 */
export function ownEndpoint(env: { DASHBOARD_ORIGIN?: string; AUTH_ORIGIN?: string }): string | null {
  const o = (env.DASHBOARD_ORIGIN || env.AUTH_ORIGIN || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/\s"'<>]+$/.test(o) && o !== "https://genclass.dev" ? `${o}/v1/events` : null;
}

function connectPanel(token: string, connected: boolean, runtimeReady: boolean, endpoint: string | null = null): string {
  const t = esc(token);
  // a self-hosted collector's endpoint goes in GenClass.init or window.GENCLASS_CONFIG (a meta tag may only name
  // same-origin URLs, src/cdn/config.ts)
  const ep = endpoint ? `, telemetry: { endpoint: "${endpoint}" }` : "";
  const cfg = (o: string) => `<script>window.GENCLASS_CONFIG = { ${o}telemetry: { endpoint: "${endpoint}" } };</script>`;
  const init = `import { GenClass } from "@genclass/runtime";\n\nGenClass.init({ token: "${token}"${ep} });`;
  const tag = `${endpoint ? `${cfg("")}\n` : ""}<script src="${CDN_SCRIPT}" data-token="${token}"></script>`;
  const meta = endpoint
    ? `<!-- in your HTML <head> -->\n${cfg(`token: "${token}", `)}\n\n// in your entry file\nimport "@genclass/runtime/auto";`
    : `<meta name="genclass" content="token=${token}">\n\n// in your entry file\nimport "@genclass/runtime/auto";`;
  let n = 0;
  const snip = (label: string, name: string, code: string) => {
    const id = `csnip${++n}`;
    return `<div><div class="sh"><span>${label}</span><button class="btn sm ghost" type="button" data-copy="${esc(code)}" data-target="${id}" aria-label="Copy ${name}">Copy</button></div><pre class="code" id="${id}" tabindex="0" aria-label="${esc(label)}">${esc(code)}</pre></div>`;
  };
  const notYet = runtimeReady ? "" : `<p class="cnote" id="cnote">${NOT_ON_NPM} So this line keeps waiting.</p>`;
  return `<section class="connect${connected ? " hidden" : ""}" id="connect" data-v="connect" aria-labelledby="connect-h">
  <div class="blk-h"><h2 id="connect-h">Connect this app</h2><span class="aside">Needs @genclass/runtime ${KEY_RUNTIME} or later</span></div>
  ${notYet}
  <div class="keyrow">
    <div class="k">Project API key</div>
    <div class="kval"><code id="ckey">${t}</code><button class="btn sm ghost" type="button" data-copy="${t}" data-target="ckey" aria-label="Copy the project API key">Copy</button></div>
    <p class="kn">Public, and safe in front-end code: it can only add telemetry to this app. It cannot open this dashboard or change anything.</p>
  </div>
  <p class="cstat" id="cstatus" aria-live="polite"><i></i><span id="cstatust">Waiting for the first event from this app</span></p>
  <div class="ways">
    ${
      endpoint
        ? ""
        : `<div class="way">
      <div class="eb">1 · Run in your project</div>
      <h3>Sign in from the terminal</h3>
      ${snip("In the app's folder", "the login command", `npx ${RUNTIME_PKG} login`)}
      <p>Signs you in and connects the app in that folder: you pick this app, it shows the change to your files, and writes the key after you agree.</p>
    </div>`
    }
    <div class="way">
      <div class="eb">${endpoint ? "Add the key and this collector's endpoint" : "2 · Or add the key yourself"}</div>
      <h3>Paste one of these</h3>
      ${snip("In code", "the init code", init)}
      ${snip("Script tag", "the script tag", tag)}
      ${snip(endpoint ? "With a bundler" : "Meta tag, with a bundler", endpoint ? "the bundler setup" : "the meta tag", meta)}
    </div>
  </div>
  <p class="fine">The key needs @genclass/runtime ${KEY_RUNTIME} or later: 0.2.x does not send it. Events arrive in batches every 10 seconds.
  Local hosts (localhost, *.local, *.test, private networks) do not send by default, even with a key (telemetry: true or a telemetry options object opts them in), so the first event usually comes from your deployed site.<span id="cpoll"> The status line above checks every 5 seconds.</span></p>
</section>`;
}

/**
 * The AI agent view (docs/runtime/AGENT.md sections 1 and 4): @genclass/mcp in Claude Code, the agent link in the app's
 * development build, what to ask. On a private link only (`privateLink`), the optional command with GENCLASS_DASHBOARD
 * for genclass_analytics `production`: the server renders MCP_ADD_DASHBOARD with its placeholder and DASH_JS fills in
 * the page's own URL. Copy buttons carry their text in data-copy (escaped), wired by DASH_JS; no inline handlers.
 */
function agentPanel(privateLink: boolean): string {
  let n = 0;
  const snip = (label: string, name: string, code: string, ids?: { pre: string; btn: string }) => {
    const id = ids?.pre ?? `asnip${++n}`;
    return `<div><div class="sh"><span>${esc(label)}</span><button class="btn sm ghost" type="button"${ids ? ` id="${ids.btn}"` : ""} data-copy="${esc(code)}" data-target="${id}" aria-label="Copy ${esc(name)}">Copy</button></div><pre class="code" id="${id}" tabindex="0" aria-label="${esc(label)}">${esc(code)}</pre></div>`;
  };
  const connect = `import { GenClass } from "@genclass/runtime";\nimport { connectAgent } from "@genclass/runtime/agent";\n\nconst rt = GenClass.init();\nif (import.meta.env.DEV) connectAgent(rt);`;
  const asks = [
    "Use GenClass to find race conditions on /checkout and fix them.",
    "The search results are sometimes wrong. Use GenClass to reproduce it, fix it and prove the fix.",
    "After my change, run genclass_explore on this page.",
  ];
  const prod = privateLink
    ? `${snip("Optional, with this dashboard's numbers", "the install command with this dashboard", MCP_ADD_DASHBOARD, { pre: "asnipd", btn: "asnipdb" })}
      <p>Use this instead of the first command to let Claude also read this dashboard's production numbers, through genclass_analytics.</p>
      <p class="cnote" id="agentwarn"><b>Private link.</b> This stores this dashboard's private link in your Claude configuration, and anyone with the link can see these stats.</p>`
    : `<p id="agentprod">Production numbers in the agent are available for private-link dashboards for now.</p>`;
  return `<section class="blk connect agent" id="agent" data-v="agent" aria-labelledby="agent-h">
  <div class="blk-h"><h2 id="agent-h">AI agent</h2><span class="aside">For Claude Code and other coding agents</span></div>
  <p class="what">GenClass's MCP server lets a coding agent see what happens in your app's pages in causal order, find race conditions by replaying responses in different orders, reproduce a bug exactly and prove the fix with a generated Playwright test.</p>
  <div class="ways">
    <div class="way">
      <div class="eb">1 · Install in Claude Code</div>
      <h3>Add the MCP server</h3>
      ${snip("In a terminal", "the install command", MCP_ADD)}
      ${snip("Or as a plugin, in Claude Code", "the plugin commands", "/plugin marketplace add genclass-dev/GenClass-lib\n/plugin install genclass@genclass")}
      ${prod}
    </div>
    <div class="way">
      <div class="eb">2 · In your app's development build</div>
      <h3>Connect your pages</h3>
      ${snip("In the app's folder", "the npm command", `npm install ${RUNTIME_PKG}`)}
      <p>The agent link needs @genclass/runtime ${esc(AGENT_RUNTIME)} or later.</p>
      ${snip("In your browser entry", "the connect code", connect)}
      <p>Next.js uses <code>process.env.NODE_ENV === "development"</code> instead of <code>import.meta.env.DEV</code>.</p>
    </div>
    <div class="way">
      <div class="eb">3 · Ask Claude</div>
      <h3>For example</h3>
      <ul class="asks">${asks.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
    </div>
  </div>
  <p class="fine">By default the agent link runs only on pages served from your machine (localhost) and talks only to the MCP server there. <a href="${AGENT_DOCS}">How it works</a></p>
</section>`;
}

export function dashboardPage(
  nonce: string,
  project: { name: string; token: string; created: string; lastEvent: string | null },
  opts: DashboardOptions = {},
): string {
  const acct = opts.account;
  if (acct && opts.locked) return lockedDashboardPage(nonce, project, { ...opts, account: acct });
  const waiting = !!acct && !project.lastEvent;
  const data = acct
    ? { ...project, id: opts.id, firstEvent: opts.firstEvent ?? null, statsUrl: `/api/account/projects/${opts.id}/stats`, account: true }
    : opts.endpoint
      ? { ...project, endpoint: opts.endpoint }
      : project;
  const apps = acct ? accountApps(acct) : "";
  const setup = acct
    ? ""
    : `<section class="blk" id="setup" data-v="setup"><details class="more" id="install"><summary>Setup: your token and install snippets</summary>
  <div class="row small mt-s"><span class="muted">Token</span><code id="ptok" class="mono brk"></code><span id="ptokc"></span></div>
  ${opts.runtimeReady === true ? "" : `<p class="note small mt-s">${NOT_ON_NPM}</p>`}
  <p class="muted small mt-s">The token needs @genclass/runtime ${KEY_RUNTIME} or later. ${LOCAL_HOSTS}</p>
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
    <a href="#top">Overview <span id="c-trend"></span></a>
    <a href="#found">Problems <span id="c-found"></span></a>
    <a href="#where">Pages <span id="c-pages"></span></a>
    <a href="#did">Actions <span id="c-did"></span></a>
    <a href="#recent-s">Activity</a>
    <a href="#visits" id="nav-visits" class="hidden">Visitors <span id="c-visits"></span></a>
    <a href="#health-s">Health</a>
    ${acct ? "" : '<a href="#setup">Setup</a><a href="#agent">AI agent</a>'}
  </nav>`;
  const help = `<div class="grp">Help</div>
  <div class="out">
    <a href="https://genclass.dev/docs/dashboard">Dashboard guide</a>
    <a href="https://genclass.dev/docs">Docs</a>
    <a href="https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md">What is collected</a>
    ${report}
    <a href="https://discord.gg/kN9kRnFtZm">Discord</a>
  </div>`;
  const side = acct
    ? `<div class="grp">Setup</div>
  <nav class="snav" id="cnav" aria-label="Setup"><a href="#connect"${waiting ? ' aria-current="true"' : ""}>Connect</a>${opts.extra ? '<a href="#forwarding">Forwarding</a><a href="#export">Export</a>' : ""}<a href="#agent">AI agent</a></nav>
  <div id="period"${waiting ? ' class="hidden"' : ""}>
  ${sections}
  </div>
  ${apps}
  ${help}`
    : `${sections}
  ${help}`;
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
  <nav class="crumbs" aria-label="Breadcrumb">${acct ? '<a href="/account">Apps</a>' : "<span>Private link</span>"}<span aria-hidden="true">/</span><span id="crumb"></span><span id="crumbv"></span></nav>
  <h1 id="pname"></h1>
  <div class="meta"><span id="updated"></span><button class="btn ghost sm" id="refresh" type="button">Refresh</button>${acct ? '<a class="btn sm" href="#connect" data-goto="connect">Connect</a>' : ""}<a class="btn ghost sm" href="https://genclass.dev/docs/dashboard">Dashboard guide</a></div>
  <p class="summary" id="summary" data-v="overview"></p>
</section>
${acct ? connectPanel(project.token, !!project.lastEvent, opts.runtimeReady === true, opts.endpoint ?? null) : ""}
<section id="nodata" class="first hidden" data-v="overview"><p>No data yet. Add the snippet under Setup to your app, load a page, and come back in a minute.
Events arrive in batches every 10 seconds and when a tab is hidden. The token needs @genclass/runtime ${KEY_RUNTIME} or later; earlier
versions ignore it. ${LOCAL_HOSTS} Your deployed site sends by default.</p></section>
<div id="content" class="hidden">
<div class="statrow" id="tiles" data-v="overview"></div>
<section class="blk" id="trend" data-v="overview">
  <div class="blk-h"><h2>Problems found</h2><span class="aside" id="trendn"></span></div>
  <figure>
    <div class="legend" id="legend"></div>
    <div class="plot" id="trendplot"></div>
    <figcaption>Fig. 1. Problems GenClass found, per <span id="unit">day</span>, by type. Hover a bar for its breakdown.</figcaption>
  </figure>
  <figure class="poss-fig hidden" id="possfig">
    <div class="poss-h"><h3>Possible issues</h3><span class="aside" id="possn"></span></div>
    <div class="plot" id="possplot"></div>
    <figcaption>Fig. 2. Possible issues per <span id="unit2">day</span>: problems the model leaned towards with less confidence than it reports at (observe mode, from the eager setting's threshold up). Not counted in Fig. 1.</figcaption>
  </figure>
  <details class="more"><summary>Table view</summary><div id="trendtable" class="mt-s"></div></details>
</section>
<section class="blk" id="rate" data-v="overview">
  <div class="blk-h"><h2>Sessions and problem rate</h2><span class="aside" id="raten"></span></div>
  <figure>
    <div class="plot" id="rateplot"></div>
    <figcaption>Fig. 3. Sessions (page loads) per <span class="unit3">day</span>, and problems found per 1,000 sessions, on the same time axis. A <span class="unit3">day</span> with no sessions has no rate, so the line breaks there. Hover or focus the top chart for a <span class="unit3">day</span>'s numbers.</figcaption>
  </figure>
  <details class="more"><summary>Table view</summary><div id="ratetable" class="mt-s"></div></details>
</section>
<section class="blk" id="found" data-v="problems">
  <div class="blk-h"><h2>What GenClass found</h2><span class="aside">Each kind of problem, where it happened and how to fix it</span></div>
  <div class="finds" id="issues"></div>
  <p class="quiet hidden" id="issuesempty">No problems found in this period.</p>
  <div id="possible-s" class="hidden mt-l">
    <div class="poss-h"><h3>Possible issues, lower confidence</h3><span class="aside">Not counted as problems</span></div>
    <p class="poss-note">By default in observe mode GenClass also reports problems the model leaned towards with less confidence than it reports at, from the eager setting's threshold up; the console marks them (possible). Worth a look when one keeps coming back on the same page.</p>
    <div class="finds" id="possible"></div>
  </div>
</section>
<section class="blk two" id="where" data-v="pages">
  <div><div class="blk-h"><h2>Pages</h2><span class="aside">Table 1. Pages with the most problems</span></div><div id="pages"></div></div>
  <div id="did"><div class="blk-h"><h2>What GenClass did</h2><span class="aside">Table 2. Actions it took</span></div><div id="acted"></div></div>
</section>
<section class="blk" id="health-s" data-v="health">
  <div class="blk-h"><h2>Health</h2><span class="aside">Whether GenClass could watch your pages at all</span></div>
  <div id="health"></div>
</section>
<section class="blk" id="recent-s" data-v="activity">
  <div class="blk-h"><h2>Recent activity</h2><span class="aside">Table 3. The latest 50 detections and interventions</span></div>
  <div class="tablewrap"><table class="dt"><thead><tr><th>Time</th><th>Page / function</th><th>What</th><th class="num">Confidence</th><th>GenClass</th><th>Mode</th></tr></thead>
  <tbody id="recent"></tbody></table></div>
  <p class="quiet hidden" id="recent0">Nothing detected in this period.</p>
</section>
<section class="blk hidden" id="visits" data-v="visitors">
  <div class="blk-h"><h2>How visitors use this app</h2><span class="aside">Interaction analytics, for apps that turn them on</span></div>
  <div id="ixsum"></div>
  <div id="ixpages" class="mt-l"></div>
</section>
<section class="blk two hidden" id="clicks" data-v="visitors">
  <div><div class="blk-h"><h2>Most clicked</h2><span class="aside">Table 5. Elements by clicks</span></div><div id="ixclicks"></div></div>
  <div><div class="blk-h"><h2>Rage and dead clicks</h2><span class="aside">Table 6. Where clicks went nowhere</span></div><div id="ixflags"></div></div>
</section>
<section class="blk" data-v="health"><details class="more"><summary>All breakdowns</summary><div class="kv mt-s" id="adv"></div></details></section>
</div>
${setup}
${agentPanel(!acct)}
${opts.extra?.html ?? ""}
<footer class="dfoot">This page shows counts only: the kind of problem, the page route, confidence, what GenClass did and how fast it
decided, and, for apps that turn on interaction analytics, page views, time on page, scroll depth and clicks per element (named by a
selector or a name the app gave it, never its text). No text from your pages, no IP addresses and no user agents are stored. Data is kept ${(opts.keepDays ?? 90) >= 365 ? "1 year" : `${opts.keepDays ?? 90} days`} (hourly detail 48 hours). ${privacy}</footer>
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

/** The sidebar's app links in account mode (more than SIDEBAR_APPS collapse to the current one). */
function accountApps(acct: NonNullable<DashboardOptions["account"]>): string {
  const many = acct.apps.length > SIDEBAR_APPS;
  const shown = many ? acct.apps.filter((a) => a.id === acct.current) : acct.apps;
  const links =
    shown.map((a) => `<a href="/account/apps/${esc(a.id)}"${a.id === acct.current ? ' aria-current="page"' : ""}>${esc(a.name)}</a>`).join("") +
    (many ? `<a href="/account#apps">All apps <span>${acct.apps.length}</span></a>` : "");
  return `<div class="grp">Your apps</div>
  <nav class="apps" aria-label="Your apps">${links}<a class="new" href="/account#new-app">New app</a></nav>
  <div class="grp">Account</div>
  <div class="out"><a href="/account">Account</a><a href="/account/billing">Plan and billing</a><form method="post" action="/logout"><button class="lnk" type="submit">Sign out</button></form></div>`;
}

/**
 * /account/apps/<id> for an account whose plan has no dashboard (a plan file without it; none today): the app's name,
 * the plans, then the Connect panel (connecting is free: the app's data is collected so the dashboard starts with it).
 * No stats are fetched.
 */
function lockedDashboardPage(
  nonce: string,
  project: { name: string; token: string; created: string; lastEvent: string | null },
  opts: DashboardOptions & { account: NonNullable<DashboardOptions["account"]> },
): string {
  const data = { ...project, id: opts.id, firstEvent: opts.firstEvent ?? null, account: true, locked: true };
  const privacy = opts.privateLink
    ? "This app also has the private dashboard link it had before it joined your account; once its plan has the dashboard, anyone with that link can see its stats. You can turn the link off on your <a href=\"/account#apps\">account page</a>."
    : "Only you can open this page, while signed in.";
  const body = `
<script type="application/json" id="project">${embed(data)}</script>
<style nonce="${nonce}">${DASH_CSS}</style>
<div class="app">
<aside class="side" aria-label="Dashboard">
  <div class="proj"><span id="sname">${esc(project.name)}</span><small>Dashboard</small></div>
  <div class="grp">Setup</div>
  <nav class="snav" id="cnav" aria-label="Setup"><a href="#connect" aria-current="true">Connect</a></nav>
  ${accountApps(opts.account)}
</aside>
<div class="mainc" id="mc" tabindex="-1">
<section class="dh" id="top">
  <h1 id="pname">${esc(project.name)}</h1>
</section>
<section class="lock" id="lock" aria-labelledby="lock-h">
  <h2 id="lock-h">This app's plan has no dashboard.</h2>
  <p>Pick a plan to open it.</p>
  <div class="acts"><a class="btn green" href="/account/billing">See plans</a></div>
</section>
${connectPanel(project.token, false, opts.runtimeReady === true, opts.endpoint ?? null)}
<footer class="dfoot">${privacy} <a href="https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md">What is collected</a> · <a href="/account">All apps</a></footer>
</div>
</div>`;
  return shell(nonce, `${project.name} | GenClass dashboard`, body, CONNECT_JS, { nav: SIGNED_IN_NAV, account: true, skip: "mc" });
}
