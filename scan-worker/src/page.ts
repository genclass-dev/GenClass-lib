// HTML for genclass.dev/scan (the URL box, progress and the report), genclass.dev/scan/about (what the scanner does,
// the score formula, opt-out and retention) and the scan worker's error pages. No external scripts: one inline script
// and one inline style per response, each under a fresh CSP nonce. Every dynamic string reaches the page through
// textContent, never innerHTML; data travels in a <script type="application/json"> block escaped by embed().

import { KINDS } from "./catalog.ts";
import { UA_TOKEN, userAgent, VIEWS } from "./scan.ts";
import { CATEGORIES, SCORE_VERSION, SEVERITY_POINTS } from "./score.ts";

export const INSTALL_LINE = '<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1" data-mode="guard"></script>';
export const OPT_OUT_EMAIL = "mehar@daybot.ca";

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
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; ` +
      "connect-src 'self'; img-src 'self' data: https://genclass.dev; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ...extra,
  };
}

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** JSON safe to embed in <script type="application/json">. */
export const embed = (v: unknown): string =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "");
}

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0E1F4D"/><path d="M9 21l5-10 4 7 2-3 3 6" fill="none" stroke="#14B86A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>');

const CSS = `
:root{
  --paper:#fff;--panel:#F5F8FB;--ink:#0E1F4D;--ink2:#3D4B6B;--ink3:#5A6684;--rule:#DFE4EC;--rule2:#C6CEDB;
  --green:#08794A;--green-f:#14B86A;--green-t:#DCF5E8;--bug:#C42A12;--bug-f:#F0451C;--bug-t:#FDE6E0;
  --code:#0B1736;--codeink:#E8EDF8;--track:#E6EBF2;
  --display:"Outfit","Helvetica Neue",Arial,sans-serif;--sans:"Figtree","Helvetica Neue",Arial,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --paper:#0B1736;--panel:#13224A;--ink:#E8EDF8;--ink2:#C3CCE2;--ink3:#97A3C2;--rule:#26355E;--rule2:#34467A;
  --green:#4FD08F;--green-f:#14B86A;--green-t:#123A2C;--bug:#FF8A6B;--bug-f:#FF7A55;--bug-t:#3A1C1A;
  --code:#060E24;--codeink:#E8EDF8;--track:#26355E;
}}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--paper);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-underline-offset:2px}
:focus-visible{outline:2px solid var(--green);outline-offset:3px}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
header.top{border-bottom:1px solid var(--rule)}
header.top .wrap{display:flex;align-items:center;gap:12px;height:60px}
.logo{display:flex;align-items:center;gap:9px;text-decoration:none}
.logo img{width:26px;height:26px}
.logo .wm{font:700 19px var(--display);letter-spacing:-.03em}
.logo .wm .g{color:var(--green-f)}
header.top nav{margin-left:auto;display:flex;gap:18px;font-size:14px;color:var(--ink2)}
header.top nav a{text-decoration:none}
header.top nav a[aria-current=page]{color:var(--ink);font-weight:600}
@media (max-width:560px){header.top nav a.opt{display:none}}
h1,h2,h3{font-family:var(--display);letter-spacing:-.03em;text-wrap:balance}
h1{font-size:clamp(30px,5vw,50px);line-height:1.05;font-weight:700}
h2{font-size:clamp(22px,2.6vw,26px);font-weight:700;line-height:1.15}
.eyebrow{font:500 12.5px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--green)}
.lead{font-size:18px;color:var(--ink2);max-width:60ch;margin-top:14px}
.muted{color:var(--ink3)}
.mono{font-family:var(--mono)}
.hidden{display:none!important}
.hero{padding:48px 0 8px}
.hero h1{margin-top:10px;overflow-wrap:anywhere}
.meta{font:12.5px var(--mono);color:var(--ink3);display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:12px}
.urlbox{display:flex;gap:8px;margin-top:26px;max-width:720px}
.urlbox input{flex:1;min-width:0;min-height:48px;padding:0 14px;border:1px solid var(--ink);border-radius:8px;background:var(--paper);color:var(--ink);font:16px var(--mono)}
.urlbox input::placeholder{color:var(--ink3)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 20px;border-radius:8px;border:1px solid var(--ink);background:var(--ink);color:var(--paper);font:600 15px var(--sans);cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover{background:#071331}
@media (prefers-color-scheme:dark){.btn:hover{background:#fff}}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--rule2)}
.btn.ghost:hover{border-color:var(--ink);background:transparent}
.btn.sm{min-height:32px;padding:0 12px;font-size:13px}
.btn:disabled{opacity:.6;cursor:progress}
.blk{margin-top:64px}
.blk-h{display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--ink)}
.blk-h .aside{font:12.5px var(--mono);color:var(--ink3)}
.intro{color:var(--ink2);max-width:62ch;margin-top:14px;font-size:16.5px}
figcaption{font:12px var(--mono);color:var(--ink3);margin-top:10px;max-width:62ch}
/* progress */
.steps{list-style:none;margin-top:28px;border-top:1px solid var(--ink);max-width:720px}
.steps li{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:12px;align-items:baseline;padding:12px 0;border-bottom:1px solid var(--rule);color:var(--ink3)}
.steps li .t{font:12.5px var(--mono);font-variant-numeric:tabular-nums}
.steps li i{width:10px;height:10px;border-radius:50%;border:1.5px solid var(--rule2);display:inline-block;transform:translateY(1px)}
.steps li.now{color:var(--ink)}
.steps li.now i{border-color:var(--ink);animation:pulse 1.2s ease-in-out infinite}
.steps li.done{color:var(--ink2)}
.steps li.done i{background:var(--ink);border-color:var(--ink)}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.steps li.now i{animation:none}}
.callout{border-top:1px solid var(--ink);margin-top:28px;padding-top:16px;max-width:72ch}
.callout p+p{margin-top:8px}
.callout.bad b{color:var(--bug)}
/* score */
.scoregrid{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:28px 56px;margin-top:36px;border-top:1px solid var(--ink);padding-top:24px}
@media (max-width:820px){.scoregrid{grid-template-columns:1fr}}
.nums{display:flex;flex-wrap:wrap;gap:20px 40px;align-items:flex-start}
.num .k{font:500 12px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)}
.num .v{font:700 76px/1 var(--display);letter-spacing:-.04em;font-variant-numeric:tabular-nums;margin-top:10px}
.num .v small{font:500 18px var(--mono);letter-spacing:0;color:var(--ink3);margin-left:6px}
.num.with .v{color:var(--green)}
.num .s{font-size:14px;color:var(--ink2);margin-top:8px;max-width:30ch}
table.dt{width:100%;border-collapse:collapse;font-size:14.5px}
table.dt th{font:500 12px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);text-align:left;padding:0 14px 10px 0;border-bottom:1px solid var(--ink);white-space:nowrap}
table.dt td{padding:11px 14px 11px 0;border-bottom:1px solid var(--rule);vertical-align:top}
table.dt .r{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:13.5px;white-space:nowrap}
table.dt td.cat{font-weight:600}
table.dt td.cat small{display:block;font-weight:400;color:var(--ink3);font-size:13px;margin-top:2px}
.bar{height:6px;border-radius:2px;background:var(--track);margin-top:8px;max-width:180px}
@media (max-width:560px){table.dt th{white-space:normal;letter-spacing:.03em;font-size:11px;padding-right:8px}table.dt td{padding-right:8px}table.dt .r{font-size:12.5px}}
.bar i{display:block;height:6px;border-radius:2px;background:var(--bug-f)}
.measures{font-size:14.5px;color:var(--ink2);margin-top:18px;max-width:72ch}
.measures b{color:var(--ink);font-weight:600}
/* screenshots */
.shots{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px 32px;margin-top:28px}
.shots figure.wide{grid-column:1/-1}
@media (max-width:700px){.shots{grid-template-columns:1fr}}
.frame{position:relative;border:1px solid var(--rule2);border-radius:4px;max-height:640px;overflow-y:auto;overflow-x:hidden;background:var(--panel)}
.phonef .frame{max-width:340px}
.frame img{display:block;width:100%;height:auto}
.frame .mark{position:absolute;border:2px solid var(--bug-f);border-radius:2px;pointer-events:none}
.frame .mark a{pointer-events:auto;position:absolute;right:100%;top:-2px;margin-right:2px;min-width:20px;height:18px;padding:0 4px;background:var(--bug-f);color:#0B1736;font:600 11px/18px var(--mono);text-align:center;text-decoration:none;border-radius:2px}
.frame .mark.in a{right:auto;left:0;top:0;margin:0}
.frame .mark.flash{outline:3px solid var(--bug-f);outline-offset:3px}
.noshot{padding:40px 16px;color:var(--ink3);font-size:14px;text-align:center}
/* findings */
ol.finds{list-style:none;margin-top:8px}
.find{display:grid;grid-template-columns:44px minmax(0,1fr);gap:4px 16px;padding:24px 0;border-bottom:1px solid var(--rule)}
.find .no{font:600 13px/26px var(--mono);color:#0B1736;background:var(--bug-f);border-radius:2px;width:30px;height:26px;text-align:center;margin-top:2px}
.find.fixed .no{background:var(--green-f)}
.find h3{font:600 18px/1.35 var(--sans);letter-spacing:-.01em}
.find .tags{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;font:12px var(--mono);color:var(--ink3)}
.find .tags .sev-high{color:var(--bug)}
.find dl{display:grid;grid-template-columns:minmax(110px,150px) minmax(0,1fr);margin-top:12px;font-size:15px}
.find dt{font:500 12px/1.9 var(--mono);color:var(--ink3);padding:6px 12px 6px 0;border-top:1px solid var(--rule)}
.find dd{padding:6px 0;border-top:1px solid var(--rule);color:var(--ink2);min-width:0;overflow-wrap:anywhere}
.find dd code{font:13.5px var(--mono);color:var(--ink)}
.find pre{background:var(--code);color:var(--codeink);border-radius:8px;padding:10px 12px;font:13px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.find .gc-yes{color:var(--green);font-weight:600}
.find .show{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
@media (max-width:560px){.find{grid-template-columns:1fr}.find dl{grid-template-columns:1fr}.find dt{border-top:0;padding-bottom:0}}
.quiet{padding:28px 0;color:var(--ink2)}
/* race probe */
dl.rows{display:grid;grid-template-columns:minmax(150px,230px) minmax(0,1fr)}
dl.rows dt,dl.rows dd{padding:16px 0;border-bottom:1px solid var(--rule)}
dl.rows dt{font:500 12.5px var(--mono);color:var(--ink3);padding-right:18px}
dl.rows dd .v{font:600 19px/1.3 var(--display);letter-spacing:-.01em}
dl.rows dd .s{font-size:14.5px;color:var(--ink2);margin-top:4px;max-width:70ch}
dl.rows dd .s code{font:13px var(--mono)}
dl.rows .cmp{display:flex;flex-wrap:wrap;gap:8px 36px;margin-top:2px}
dl.rows .cmp div{min-width:0}
dl.rows .cmp .k{font:500 12px var(--mono);color:var(--ink3)}
dl.rows .cmp .n{font:700 30px/1.1 var(--display);font-variant-numeric:tabular-nums}
dl.rows .cmp .n.g{color:var(--green)}
@media (max-width:560px){dl.rows{grid-template-columns:1fr}dl.rows dt{border-bottom:0;padding-bottom:0}}
ul.limits{list-style:none;margin-top:8px;max-width:78ch}
ul.limits li{padding:12px 0;border-bottom:1px solid var(--rule);color:var(--ink2);font-size:15.5px}
ul.limits li b{color:var(--ink);font-weight:600}
/* call to action (the one dark block) */
.cta{margin-top:72px;background:#0B1736;color:#E8EDF8;border-radius:14px;padding:clamp(24px,4vw,44px);display:grid;gap:18px 40px;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);align-items:start}
@media (max-width:820px){.cta{grid-template-columns:1fr}}
@media (prefers-color-scheme:dark){.cta{background:#060E24;border:1px solid var(--rule)}}
.cta h2{color:#fff}
.cta p{color:#C3CCE2;margin-top:10px;max-width:56ch}
.cta pre{background:#060E24;border:1px solid #26355E;border-radius:10px;padding:12px 14px;font:13.5px/1.6 var(--mono);color:#7EE2AE;white-space:pre-wrap;overflow-wrap:anywhere}
.cta .row{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.cta .btn{background:#14B86A;border-color:#14B86A;color:#0B1736}
.cta .btn:hover{background:#0FA35D}
.cta .btn.ghost{background:transparent;border-color:#34467A;color:#E8EDF8}
.cta .btn.ghost:hover{border-color:#E8EDF8}
.share{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-top:16px;font:13px var(--mono);color:var(--ink3)}
.share code{color:var(--ink2);overflow-wrap:anywhere}
footer.dfoot{margin:72px 0 40px;padding-top:18px;border-top:1px solid var(--rule);font-size:13.5px;color:var(--ink3);max-width:90ch}
footer.dfoot a{color:var(--ink2)}
/* about */
.prose{max-width:74ch}
.prose p,.prose ul,.prose ol{margin-top:12px;color:var(--ink2)}
.prose ul,.prose ol{padding-left:20px}
.prose li+li{margin-top:6px}
.prose code{font:14px var(--mono);color:var(--ink)}
.prose pre{background:var(--code);color:var(--codeink);border-radius:10px;padding:12px 14px;font:13.5px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:12px}
.elapsed{margin-top:12px;font:12.5px var(--mono);color:var(--ink3)}
.cta .cta-k{margin-top:0;font:12.5px var(--mono);color:#97A3C2}
.cta .cta-s{font-size:14px}
.cta .cta-s code{font:13.5px var(--mono);color:#E8EDF8}
code.kind{font:12.5px var(--mono);color:var(--ink3)}
.two{display:grid;gap:40px;grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr));margin-top:28px}
.prose h3.h3{margin-top:28px;font-size:19px;color:var(--ink)}
.formula{font:15px/1.7 var(--mono);color:var(--ink);border-top:1px solid var(--ink);border-bottom:1px solid var(--rule);padding:16px 0;margin-top:18px;overflow-wrap:anywhere}
`;

function shell(n: string, title: string, current: "scan" | "about", body: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<meta name="description" content="Check one public page for unreadable text, broken images, layout overflow, covered controls and double-submit races. Requests that could change something on the site are never sent.">
<link rel="icon" href="${ICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Figtree:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap">
<style nonce="${n}">${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="logo" href="https://genclass.dev/" aria-label="GenClass home"><img src="https://genclass.dev/brand/mark-64.png" alt="" width="26" height="26"><span class="wm"><span>gen</span><span class="g">class</span></span></a>
<nav aria-label="Main"><a href="/scan"${current === "scan" ? ' aria-current="page"' : ""}>Page check</a><a href="/scan/about"${current === "about" ? ' aria-current="page"' : ""}>How it works</a><a class="opt" href="https://genclass.dev/docs">Docs</a></nav></div></header>
<main class="wrap">${body}</main>
${script ? `<script nonce="${n}">${script}</script>` : ""}
</body>
</html>`;
}

// ------------------------------------------------------------------------------------------- /scan

export interface ScanPageData {
  target: { url: string; display: string } | null;
  input: string;
  error: { code: string; message: string } | null;
  report: unknown;
  shareBase: string;
}

const LIMITS = [
  ["One page, one load.", "Problems that need a second page, a signed-in user or a slow network do not show up here."],
  ["No real users.", "The probe types three letters and double-clicks one button. Real visitors do far more, on slower networks. GenClass in production watches the requests their actions make."],
  ["Nothing that changes data is sent.", "POST, PUT, PATCH and DELETE requests get a stand-in reply from the scanner instead. If the page loads content that way, that content is missing or wrong here, and findings that may come from it are listed but not scored."],
  ["Some checks need a known background.", "Text over images, gradients or video is skipped by the contrast check rather than guessed at."],
  ["No clicks on the page.", "The scanner presses Tab and scrolls, but clicks only the probe's submit button, so checks that need a visitor's clicks (an invisible layer that swallows them) do not run here."],
  ["Six seconds per view.", "Problems that appear later, after a timer or a second interaction, are not seen."],
  ["Bot protection.", "Some sites show a challenge page to automated browsers. The report then describes that page, not the site."],
];

export function scanPage(n: string, data: ScanPageData): string {
  const t = data.target;
  const body = `
<script type="application/json" id="data">${embed(data)}</script>
<section class="hero">
  <p class="eyebrow">Page check</p>
  <h1 id="title">${t ? esc(t.display) : "What breaks on one page load."}</h1>
  <div class="meta" id="meta"></div>
  <form class="urlbox" action="/scan" method="get" role="search">
    <label class="sr" for="u">Address of a public page</label>
    <input id="u" name="url" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="2048" placeholder="example.com/pricing" value="${esc(data.input)}">
    <button class="btn" id="go" type="submit">Check page</button>
  </form>
  <p class="lead" id="lead"${t ? ' hidden' : ""}>Paste an address. A browser loads the page on a desktop and on a phone, light and dark, and checks
  for text you cannot read, images and stylesheets that failed, sideways scrolling, a page that ignores clicks or cannot scroll,
  and controls hidden under fixed bars, with the same measured checks the GenClass runtime ships. Then it types
  into the search box and double-clicks a submit button to look for races, with GenClass watching. Requests that could change
  something on the site are answered inside the browser and never sent.</p>
</section>
<section id="progress" class="hidden" aria-live="polite">
  <ol class="steps" id="steps"></ol>
  <p class="elapsed" id="elapsed"></p>
</section>
<section id="problem" class="callout bad hidden" role="alert"><p><b id="problemt"></b></p><p id="problemd" class="muted"></p></section>
<div id="result" class="hidden">
  <section class="scoregrid" id="scorebox" aria-labelledby="sh">
    <div>
      <h2 class="sr" id="sh">Score</h2>
      <div class="nums">
        <div class="num"><div class="k" id="sk">Score</div><div class="v"><span id="sv"></span><small>/ 100</small></div><div class="s" id="ss"></div></div>
        <div class="num with hidden" id="withbox"><div class="k">With GenClass on</div><div class="v"><span id="wv"></span><small>/ 100</small></div><div class="s" id="ws"></div></div>
      </div>
    </div>
    <div>
      <table class="dt"><thead><tr><th>Category</th><th class="r">Findings</th><th class="r">Deducted</th><th class="r hidden" id="wth">With GenClass</th></tr></thead><tbody id="breakdown"></tbody></table>
      <p class="measures" id="measures"><b>What the score measures:</b> this page, this one load, in three views, against the checks listed on
      <a href="/scan/about#score">How it works</a>. Each finding takes 10, 5 or 2 points by severity, and no category can take more than 25.
      <b>What it does not measure:</b> speed, SEO, accessibility beyond contrast, or anything that needs a signed-in user or a second page.</p>
      <div class="share" id="share"></div>
    </div>
  </section>
  <section class="blk" id="where">
    <div class="blk-h"><h2>Where the findings are</h2><span class="aside" id="figs"></span></div>
    <div class="shots" id="shots"></div>
  </section>
  <section class="blk" id="list">
    <div class="blk-h"><h2>Findings</h2><span class="aside" id="listn"></span></div>
    <ol class="finds" id="finds"></ol>
    <p class="quiet hidden" id="none">No findings from these checks on this load. That is a good sign for these checks only; see what one load cannot show, below.</p>
  </section>
  <section class="blk" id="race">
    <div class="blk-h"><h2>Race probe</h2><span class="aside">What was tried, and what GenClass saw</span></div>
    <p class="intro">On the desktop page, with the GenClass runtime loaded in observe mode, the scanner typed into the first search box
    and double-clicked the most prominent submit button. Requests other than GET were answered inside the browser and never reached
    the site; GET responses got up to 1.5 s of extra latency so they could arrive out of order. Then it did the same again in a
    fresh page with GenClass in guard mode.</p>
    <dl class="rows" id="probe"></dl>
    <figcaption>Table 2. The race probe without GenClass, and again with GenClass in guard mode, measured in the same browser.</figcaption>
  </section>
  <section class="blk" id="limits">
    <div class="blk-h"><h2>What one page load cannot show</h2><span class="aside">Read the score with these in mind</span></div>
    <ul class="limits">${LIMITS.map(([a, b]) => `<li><b>${esc(a)}</b> ${esc(b)}</li>`).join("")}</ul>
  </section>
</div>
<section class="cta" id="cta" aria-labelledby="ctah">
  <div>
    <h2 id="ctah">Watch every visit, not one page load.</h2>
    <p>GenClass runs inside your pages for real visitors and reports the races that only real traffic triggers: responses that land
    over newer data, duplicate submits, endpoints that keep failing. In guard mode it can merge a duplicate submit or drop a late
    response when the expected gain clears its safety margin. The race probe above shows whether it did on this page. The visual
    checks above are the ones the runtime runs with <code>visual: { on: true }</code>; with <code>fix: true</code> in guard mode it
    also fixes invisible text, a leaked <code>pointer-events: none</code> and a leaked scroll lock for your visitors, and reports
    the rest to you.</p>
    <div class="row"><a class="btn" href="https://genclass.dev/start">Get a token and a dashboard</a><a class="btn ghost" href="https://genclass.dev/docs">Read the docs</a></div>
  </div>
  <div>
    <p class="cta-k">Install in one line, first thing in &lt;head&gt;</p>
    <pre id="install">${esc(INSTALL_LINE)}</pre>
    <p class="cta-s">Or <code>npm i @genclass/runtime</code>. Free and open source (Apache-2.0).</p>
  </div>
</section>
<footer class="dfoot">The page check loads one public page in a Cloudflare browser with the user agent token <code class="mono">${esc(UA_TOKEN)}</code>.
It never sends forms or other non-GET requests to the site and never follows links. Results are cached for 6 hours; screenshots are
deleted after 24 hours. Site owners can opt out: <a href="/scan/about#opt-out">how</a>. <a href="/scan/about">How the score works</a>.</footer>`;
  return shell(n, t ? `${t.display} | GenClass page check` : "Page check | GenClass", "scan", body, CLIENT_JS);
}

// The client: progress over the NDJSON stream, then the report. textContent only.
const CLIENT_JS = `(function(){
"use strict";
var D = JSON.parse(document.getElementById("data").textContent);
var $ = function(id){ return document.getElementById(id); };
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
function show(id, on){ $(id).classList.toggle("hidden", !on); }
var nf = new Intl.NumberFormat("en-US");
function secs(ms){ return (Math.round(ms / 100) / 10).toFixed(1) + " s"; }
var STEPS = [["check","Checking the address and robots.txt"],["browser","Starting a browser"],["views","Loading the page: desktop, phone, phone dark"],["checks","Running the GenClass visual checks, with and without its fixes, and taking screenshots"],["probe","Race probe: typing and a double click, GenClass in observe mode"],["guard","The same probe with GenClass in guard mode"],["save","Scoring and saving the report"]];
var t0 = 0, timer = null;

function problem(title, detail){
  show("progress", false); show("problem", true);
  $("problemt").textContent = title; $("problemd").textContent = detail || "";
  $("go").disabled = false;
  if (timer) { clearInterval(timer); timer = null; }
}
function progress(step){
  var host = $("steps");
  if (!host.children.length) STEPS.forEach(function(s){ var li = el("li"); li.dataset.step = s[0]; li.appendChild(el("i")); li.appendChild(el("span", null, s[1])); li.appendChild(el("span", "t", "")); host.appendChild(li); });
  var reached = false;
  Array.prototype.forEach.call(host.children, function(li){
    if (li.dataset.step === step) { reached = true; if (!li.classList.contains("now")) { li.classList.add("now"); li.dataset.at = String(Date.now()); } return; }
    if (!reached && li.classList.contains("now")) { li.classList.remove("now"); li.classList.add("done"); li.lastChild.textContent = secs(Date.now() - Number(li.dataset.at || Date.now())); }
    if (!reached && !li.classList.contains("done")) { li.classList.add("done"); }
  });
}
function start(){
  show("progress", true); show("problem", false); $("go").disabled = true;
  t0 = Date.now(); progress("check");
  timer = setInterval(function(){ $("elapsed").textContent = secs(Date.now() - t0) + " elapsed. A scan usually takes 10 to 25 seconds."; }, 200);
  fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: D.target.url }) }).then(function(res){
    var ct = res.headers.get("content-type") || "";
    if (ct.indexOf("ndjson") < 0) return res.json().then(function(j){ refused(res.status, j); }, function(){ problem("The scanner did not answer.", "HTTP " + res.status + ". Try again in a minute."); });
    var reader = res.body.getReader(), dec = new TextDecoder(), buf = "", finished = false;
    function pump(){
      return reader.read().then(function(r){
        if (r.value) buf += dec.decode(r.value, { stream: true });
        var lines = buf.split("\\n"); buf = lines.pop();
        lines.forEach(function(line){ if (!line.trim()) return; var m; try { m = JSON.parse(line); } catch (e) { return; }
          if (m.type === "progress") progress(m.step);
          else if (m.type === "done") { finished = true; done(m.report); }
          else if (m.type === "error") { finished = true; problem(m.message || "The scan failed.", m.detail || ""); } });
        if (r.done) { if (!finished) problem("The scan stopped before it finished.", "The connection closed. Reload the page to see whether a result was saved."); return; }
        return pump();
      });
    }
    return pump();
  }).catch(function(){ problem("Could not reach the scanner.", "Check your connection and try again."); });
}
var retried = false;
function refused(status, j){
  var code = j && j.code;
  if (code === "in-progress") { progress("views"); return poll(0); }
  if (j && j.report) return done(j.report);
  var title = (j && j.message) || ("The scanner answered HTTP " + status + ".");
  var detail = code === "rate" ? "Each visitor can start five new scans a minute. Results are cached for 6 hours, so a shared link does not start a new scan."
    : code === "site-rate" ? "Each site can have a few new scans started a minute, whoever asks. Try again in a minute."
    : code === "running" ? "Each visitor can run one scan at a time. Try again when it has finished."
    : status === 503 ? "Every scanner is busy right now. Try again in a minute." : "";
  problem(title, detail);
}
function poll(n){
  // a scan that stopped because its page closed saves nothing: after a while, start one again
  if (n === 4 && !retried) { retried = true; return start(); }
  if (n > 15) return problem("Someone else started a scan of this page and it has not finished.", "Reload in a minute to see the result.");
  setTimeout(function(){
    fetch("/api/scan/report?url=" + encodeURIComponent(D.target.url)).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){ if (j && j.report) done(j.report); else poll(n + 1); }, function(){ poll(n + 1); });
  }, 4000);
}
function done(r){
  if (timer) { clearInterval(timer); timer = null; }
  progress("__end");
  show("progress", false); show("problem", false); $("go").disabled = false;
  render(r);
}

function render(r){
  show("result", true);
  $("title").textContent = r.display;
  var meta = $("meta"); meta.textContent = "";
  [r.url, "Scanned " + new Date(r.scannedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), secs(r.ms.total) + " in total", "@genclass/runtime " + r.runtime].forEach(function(t){ meta.appendChild(el("span", null, t)); });
  renderScore(r); renderShots(r); renderFindings(r); renderProbe(r); renderShare(r);
  if (history.replaceState && D.target) { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {} }
}

function renderScore(r){
  $("sv").textContent = String(r.score.value);
  var scored = r.findings.filter(function(f){ return !f.unscored; }), n = scored.length, extra = r.findings.length - n, high = scored.filter(function(f){ return f.severity === "high"; }).length;
  $("ss").textContent = (n ? nf.format(n) + (n === 1 ? " finding" : " findings") + (high ? ", " + high + " serious" : "") + ". The table shows where the points went." : "No scored findings from these checks.")
    + (extra ? " " + extra + (extra === 1 ? " more is" : " more are") + " listed but not scored." : "");
  var w = r.withGenClass, withOn = !!(w && w.shown);
  show("withbox", withOn); show("wth", withOn);
  $("sk").textContent = withOn ? "Without GenClass" : "Score";
  if (withOn) { $("wv").textContent = String(w.value); $("ws").textContent = (n ? w.fixed + " of " + n + (w.fixed === 1 ? " finding" : " findings") + " fixed in the page by GenClass and gone on a re-check in the same browser. GenClass reports the rest for the developer, with the suggested fix." : "Nothing to fix on this load."); }
  var tb = $("breakdown"); tb.textContent = "";
  r.score.categories.forEach(function(c, i){
    var tr = el("tr"), td = el("td", "cat", c.label); td.appendChild(el("small", null, "Up to " + c.cap + " points"));
    var bar = el("div", "bar"), fill = el("i"); fill.style.width = Math.round(100 * c.deducted / c.cap) + "%"; bar.appendChild(fill); td.appendChild(bar);
    tr.appendChild(td); tr.appendChild(el("td", "r", String(c.count))); tr.appendChild(el("td", "r", c.deducted ? "-" + c.deducted : "0"));
    if (withOn) { var wc = w.breakdown.categories[i]; tr.appendChild(el("td", "r", wc.deducted ? "-" + wc.deducted : "0")); }
    tb.appendChild(tr);
  });
  if (withOn) $("measures").appendChild(el("span", null, " " + w.note));
}

var MARKS = {};
function renderShots(r){
  var host = $("shots"); host.textContent = ""; MARKS = {};
  var figs = 0;
  r.views.forEach(function(v, vi){
    var fig = el("figure", v.id === "desktop" ? "wide" : "phonef"); fig.id = "fig-" + v.id;
    var frame = el("div", "frame"); frame.id = "frame-" + v.id;
    var mine = r.findings.filter(function(f){ return f.boxes && f.boxes[v.id]; });
    if (v.shot) {
      var img = el("img"); img.src = v.shot; img.alt = "Screenshot of " + r.display + ", " + v.label + ", with " + mine.length + " findings marked"; img.width = v.width; img.height = v.shotHeight; img.loading = vi ? "lazy" : "eager";
      frame.appendChild(img);
      mine.forEach(function(f){
        var b = f.boxes[v.id]; if (b.y > v.shotHeight) return;
        var m = el("div", "mark" + (b.x < 0.06 * v.width ? " in" : ""));
        m.style.left = (100 * Math.max(0, b.x) / v.width) + "%"; m.style.top = (100 * Math.max(0, b.y) / v.shotHeight) + "%";
        m.style.width = (100 * Math.min(b.w, v.width - Math.max(0, b.x)) / v.width) + "%"; m.style.height = (100 * Math.min(b.h, v.shotHeight - Math.max(0, b.y)) / v.shotHeight) + "%";
        var a = el("a", null, String(f.n)); a.href = "#f-" + f.n; a.setAttribute("aria-label", "Finding " + f.n + ": " + f.what);
        m.appendChild(a); frame.appendChild(m); MARKS[v.id + ":" + f.n] = m;
      });
    } else frame.appendChild(el("div", "noshot", v.ok ? "No screenshot for this view." : (v.error || "This view did not load.")));
    fig.appendChild(frame);
    figs++;
    var cap = "Fig. " + figs + ". " + v.label + ". " + (v.ok ? (mine.length ? mine.length + (mine.length === 1 ? " finding" : " findings") + " marked" : "Nothing marked") + (v.shot ? ", top " + nf.format(v.shotHeight) + " px of the page" : "") + "." : "Did not load.");
    if (v.notes && v.notes.length) cap += " " + v.notes.join(" ");
    fig.appendChild(el("figcaption", null, cap));
    host.appendChild(fig);
  });
  $("figs").textContent = "Fig. 1 to " + figs + ". Numbers match the list below";
  unstackAll();
}
// number tags of boxes that start close together are moved down until none overlaps another, so every number reads
function unstackAll(){
  Array.prototype.forEach.call(document.querySelectorAll("#shots .frame"), function(frame){
    var tags = Array.prototype.map.call(frame.querySelectorAll(".mark a"), function(a){ a.style.transform = ""; var r = a.getBoundingClientRect(); return { a: a, x: r.left, y: r.top, w: r.width, h: r.height }; });
    tags.sort(function(p, q){ return p.y - q.y || p.x - q.x; });
    var placed = [];
    tags.forEach(function(t){
      var dy = 0, moved = true, guard = 0;
      while (moved && guard++ < 50) {
        moved = false;
        for (var i = 0; i < placed.length; i++) {
          var p = placed[i];
          if (t.x < p.x + p.w + 2 && p.x < t.x + t.w + 2 && t.y + dy < p.y + p.h + 2 && p.y < t.y + dy + t.h + 2) { dy = p.y + p.h + 2 - t.y; moved = true; }
        }
      }
      if (dy) t.a.style.transform = "translateY(" + Math.round(dy) + "px)";
      placed.push({ x: t.x, y: t.y + dy, w: t.w, h: t.h });
    });
  });
}
var resizeTimer = null;
window.addEventListener("resize", function(){ clearTimeout(resizeTimer); resizeTimer = setTimeout(unstackAll, 150); });

var VIEWNAMES = { desktop: "Desktop", phone: "Phone", "phone-dark": "Phone, dark", probe: "Race probe" };
function renderFindings(r){
  var host = $("finds"); host.textContent = "";
  show("none", !r.findings.length);
  var withOn = !!(r.withGenClass && r.withGenClass.shown);
  var nfix = r.findings.filter(function(f){ return f.fixed; }).length;
  $("listn").textContent = r.findings.length ? "Table 1. " + r.findings.length + (r.findings.length === 1 ? " finding" : " findings") + ", most serious first" + (withOn ? ". " + nfix + " fixed by GenClass, " + (r.findings.length - nfix) + " reported for the developer" : "") : "Table 1. No findings";
  r.findings.forEach(function(f){
    var li = el("li", "find" + (withOn && f.fixed ? " fixed" : "")); li.id = "f-" + f.n;
    li.appendChild(el("div", "no", String(f.n)));
    var main = el("div");
    main.appendChild(el("h3", null, f.what));
    var tags = el("div", "tags");
    tags.appendChild(el("span", "sev-" + f.severity, f.severity === "high" ? "Serious" : f.severity === "medium" ? "Moderate" : "Minor"));
    tags.appendChild(el("span", null, ({ readability: "Readability", media: "Images and media", layout: "Layout", interaction: "Interaction and races" })[f.category]));
    tags.appendChild(el("span", null, f.views.map(function(v){ return VIEWNAMES[v] || v; }).join(" · ")));
    if (f.unscored) tags.appendChild(el("span", null, "Not scored"));
    main.appendChild(tags);
    var dl = el("dl");
    function row(k, node){ dl.appendChild(el("dt", null, k)); var dd = el("dd"); if (typeof node === "string") dd.textContent = node; else dd.appendChild(node); dl.appendChild(dd); return dd; }
    if (f.selector) { var c = el("code", null, f.selector); row("Where", c); }
    row("Measured", f.measured);
    if (f.unscored) row("Not scored", f.unscored);
    row("Why it matters", f.why);
    var pre = el("pre", null, f.fix); row("Suggested fix", pre);
    if (withOn) row("With GenClass", f.fixed ? el("span", "gc-yes", "Fixed. " + f.fixed.how) : el("span", null, f.genclass ? f.genclass.text : "Not fixed in this run. The suggested fix above removes it."));
    var shown = Object.keys(f.boxes || {});
    if (shown.length) {
      var bar = el("div", "show");
      shown.forEach(function(v){ var b = el("button", "btn ghost sm", "Show on " + (VIEWNAMES[v] || v).toLowerCase()); b.type = "button"; b.addEventListener("click", function(){ reveal(v, f); }); bar.appendChild(b); });
      row("Screenshot", bar);
    }
    main.appendChild(dl); li.appendChild(main); host.appendChild(li);
  });
}
function reveal(view, f){
  var frame = $("frame-" + view), m = MARKS[view + ":" + f.n]; if (!frame || !m) return;
  $("fig-" + view).scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  frame.scrollTop = Math.max(0, m.offsetTop - 60);
  m.classList.add("flash"); setTimeout(function(){ m.classList.remove("flash"); }, 1600);
}

function renderProbe(r){
  var dl = $("probe"); dl.textContent = "";
  var o = r.probe && r.probe.observe, g = r.probe && r.probe.guard;
  function row(k, v, s){ dl.appendChild(el("dt", null, k)); var dd = el("dd"); if (v) dd.appendChild(typeof v === "string" ? el("div", "v", v) : v); if (s) dd.appendChild(el("div", "s", s)); dl.appendChild(dd); }
  if (!o) { row("Probe", "Did not run", (r.notes || []).join(" ")); return; }
  if (!o.ran) { row("Probe", "Did not run", o.note || ""); return; }
  var m = o.model || {};
  var modelLine = m.state === "ready" ? "Loaded in " + secs(m.loadMs || m.waitedMs) + (m.device ? " on " + m.device.toUpperCase() : "") + (m.variant ? ", " + m.variant : "")
    : m.state === "absent" ? "Not loaded" : "Did not load in time";
  var nd = o.decisions || 0;
  var modelSub = m.state === "ready" ? (nd ? "GenClass made " + nd + (nd === 1 ? " decision" : " decisions") + " on this page with its local model, as it would in a visitor's browser." : "The model was ready. GenClass made no decisions on this page.")
    : m.state === "absent" ? "The GenClass runtime could not be fetched for this scan, so nothing below was seen by GenClass."
    : "The model was still " + (m.state || "loading") + " after " + secs(m.waitedMs) + (m.error ? " (" + m.error + ")" : "") + ". Without it GenClass only observes, so it could not diagnose anything on this run.";
  row("GenClass model", modelLine, modelSub);
  var staleSeen = (o.detections || []).some(function(d){ return d.diagnosis === "stale"; });
  if (o.typed) row("Typing", o.typed.requests + (o.typed.requests === 1 ? " request" : " requests") + " while typing", "Typed a, ab, abc into " + o.typed.target + ", 80 ms apart. " + (o.typed.requests ? (o.typed.outOfOrder ? "Responses came back out of order (" + o.typed.completionOrder.join(", ") + ")." + (staleSeen ? "" : " Whether the page then showed results for an older query was not checked.") : "Responses came back in order.") : "The page made no requests while typing."));
  else row("Typing", "Not tried", o.typeSkipped || "");
  if (o.clicked) row("Double click", o.clicked.sent + (o.clicked.sent === 1 ? " request" : " requests") + " from one double click", "Double-clicked " + (o.clicked.label ? "\\u201c" + o.clicked.label + "\\u201d (" + o.clicked.target + ")" : o.clicked.target) + ". " + (o.clicked.identical >= 2 ? o.clicked.identical + " were identical." : o.clicked.sent ? "No two were identical." : "The page sent nothing; its own code may block the second click, or the form needs input first.") + " All were answered inside the browser. The form was submitted empty, with its browser validation turned off; a visitor who fills it in and double-clicks sends the same submits.");
  else row("Double click", "Not tried", o.clickSkipped || "");
  var seen = o.detections || [], triedAny = !!(o.typed || o.clicked);
  if (seen.length) row("GenClass saw", seen.length + (seen.length === 1 ? " problem" : " problems"), seen.slice(0, 4).map(function(d){ return d.diagnosis + " (" + Math.round(d.p * 100) + "%) on " + d.subject; }).join("; ") + ".");
  else if (!triedAny) row("GenClass saw", "Nothing to probe on this page", "The page has no search box and no form that posts, so the probe had nothing to type into or click. GenClass watched the page load and flagged nothing. In production GenClass watches the requests real visitors' actions make.");
  else row("GenClass saw", "Nothing on this run", m.state === "ready" ? "Nothing in this short probe looked wrong to GenClass. In production GenClass watches the requests real visitors' actions make." : "With no model, GenClass could not diagnose anything here.");
  if (g && g.ran && o.clicked && g.clicked) {
    var cmp = el("div", "cmp"), acted = !!(r.probe.guardClick && r.probe.guardClick.acted);
    [["Without GenClass", o.clicked.sent, ""], ["With GenClass guard", g.clicked.sent, acted ? "g" : ""]].forEach(function(x){ var d = el("div"); d.appendChild(el("div", "k", x[0])); d.appendChild(el("div", "n " + x[2], x[1] + (x[1] === 1 ? " request" : " requests"))); cmp.appendChild(d); });
    var acts = (g.acts || []).map(function(a){ return a.action + ": " + String(a.changed || "").replace(/\\.$/, ""); });
    var held = (g.detections || []).filter(function(d){ return !d.executed && d.candidate && typeof d.gain === "number" && typeof d.margin === "number"; })[0];
    var dflt = r.probe.guardMargin === null && r.probe.guardAggressiveness === "balanced";
    var WORDS = { duplicate: "a duplicate", stale: "a late response", conflict: "a conflict", inconsistent: "an inconsistency", failing: "a failing request" };
    var MOVES = { coalesce: "merging the two", discard: "dropping it", defer: "holding it back", retry: "retrying it", cancel: "cancelling it" };
    var why = acted ? r.probe.guardClick.how
      : acts.length ? "GenClass did: " + acts.slice(0, 3).join("; ") + ". That did not change what the double click sent."
      : held ? "Flagged, held back at " + (dflt ? "the default safety margin" : "this setting's safety margin") + ": GenClass was " + Math.round(held.p * 100) + "% sure this was " + (WORDS[held.diagnosis] || held.diagnosis) + ", but " + (MOVES[held.candidate] || held.candidate) + " had an expected gain of " + (Math.round(held.gain * 100) / 100) + " against a margin of " + held.margin + ", so it did not act and both requests went out."
      : (g.model || {}).state === "ready" ? "GenClass took no action." : "GenClass took no action: its model did not load in time.";
    row("Guard mode", cmp, "Measured, not projected: the same double click in a fresh page with " + (r.probe.guardSetting || "GenClass in guard mode") + ". " + why);
  } else if (g && g.ran && !triedAny) row("Guard mode", "Nothing to compare", "With nothing to type into or click, guard mode had nothing to change on this page.");
  else if (g && g.ran && o.typed && !o.clicked) row("Guard mode", "Typing only", "The guard pass typed the same letters" + ((g.acts || []).length ? " and GenClass did: " + g.acts.slice(0, 3).map(function(a){ return a.action + ": " + a.changed; }).join("; ") + "." : "; GenClass took no action."));
  else if (g && !g.ran) row("Guard mode", "Not measured", g.note || "");
  else if (!g) row("Guard mode", "Not measured", (r.notes || []).filter(function(n){ return /guard/i.test(n); }).join(" ") || "The guard pass did not run on this scan.");
}

function renderShare(r){
  var host = $("share"); host.textContent = "";
  var url = D.shareBase === "https://genclass.dev" && /^[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/.test(r.display) ? D.shareBase + "/" + r.display : D.shareBase + "/scan?url=" + encodeURIComponent(r.display);
  host.appendChild(el("span", null, "Share"));
  host.appendChild(el("code", null, url));
  var b = el("button", "btn ghost sm", "Copy link"); b.type = "button";
  b.addEventListener("click", function(){ if (navigator.clipboard) navigator.clipboard.writeText(url).then(function(){ b.textContent = "Copied"; setTimeout(function(){ b.textContent = "Copy link"; }, 1500); }); });
  host.appendChild(b);
  host.appendChild(el("span", null, "Cached for 6 hours."));
}

// the same address again: scan it here, without reloading the page
document.querySelector("form.urlbox").addEventListener("submit", function(e){
  if (D.target && !D.report && !D.error && $("u").value.trim() === D.input && !$("go").disabled) { e.preventDefault(); start(); }
});
// crawlers and automated browsers that run scripts can read a cached report, but loading the page does not start a scan
var automated = navigator.webdriver === true || /bot\\b|bot\\/|crawl|spider|slurp|headless|lighthouse|preview/i.test(navigator.userAgent || "");
if (D.error) problem(D.error.message, D.error.code === "robots" || D.error.code === "opted-out" ? "Site owners can opt out of the page check; this site has." : "");
else if (D.report) render(D.report);
else if (D.target && !automated) start();
})();`;

// ------------------------------------------------------------------------------------- /scan/about

export function aboutPage(n: string): string {
  const kinds = Object.entries(KINDS)
    .map(([k, v]) => `<tr><td>${esc(v.what)}<br><code class="kind">${esc(k)}</code></td><td>${esc(CATEGORIES.find((c) => c.id === v.category)!.label)}</td><td>${esc(v.severity)}</td><td class="r">${SEVERITY_POINTS[v.severity]}</td></tr>`)
    .join("");
  const cats = CATEGORIES.map((c) => `<tr><td class="cat">${esc(c.label)}<small>${esc(c.covers)}</small></td><td class="r">${c.cap}</td></tr>`).join("");
  const body = `
<section class="hero">
  <p class="eyebrow">Page check</p>
  <h1>How the page check works.</h1>
  <p class="lead">What the scanner loads, what it never does, how the score is computed, and how a site owner opts out.</p>
</section>
<section class="blk prose" id="what">
  <div class="blk-h"><h2>What it does</h2></div>
  <ol>
    <li>Normalises the address (https:// is added when missing; only http and https on the standard ports) and refuses IP
    addresses, local names, genclass.dev itself and hostnames that resolve to private, loopback, link-local, carrier-grade NAT or
    cloud metadata addresses. It reads the site's <code>robots.txt</code> for a <code>GenClassScan</code> group.</li>
    <li>Starts a fresh browser (Cloudflare Browser Rendering) with no cookies or storage, and loads the page three times in
    parallel: ${VIEWS.map((v) => esc(v.label.toLowerCase())).join("; ")}. Each load has 20 seconds, then up to 4 more for the network to go quiet.</li>
    <li>Runs the GenClass visual checks in each view for about 6 seconds: the runtime's own measured checks
    (<code>@genclass/runtime</code> visual chunk), in an isolated part of the browser the page's scripts cannot reach. It presses
    Tab a few times on the desktop and scrolls with the mouse wheel, which some checks need (focus under a sticky header, a
    scroll lock, a control under a fixed bar). With GenClass on, the checks run in guard mode with their fixes turned on, and a
    second, report-only set of the same checks then measures the page again; the fixes are undone before the screenshot.</li>
    <li>Takes a screenshot of the top of the page in each view and records the box of every finding.</li>
    <li>On the desktop page, with the GenClass runtime loaded in observe mode (telemetry off, model from
    <code>genclass.dev/model/</code>), types <code>a</code>, <code>ab</code>, <code>abc</code> into the first search box, 80 ms apart,
    and double-clicks the most prominent submit button of a same-origin form that would POST. Forms with a password or card
    field are skipped, and so are forms and buttons that would submit into another window. GET responses during the probe get 0 to 1,500 ms of extra latency, so they can arrive out of order.</li>
    <li>Opens the page once more with GenClass in guard mode and repeats the probe, to measure what guard changes.</li>
    <li>Scores the findings and keeps the report for 6 hours. The whole scan has a hard budget of 45 seconds. When the page sent
    requests other than GET while loading, findings that may come from the scanner's stand-in replies (template text, broken
    images, and GenClass diagnoses other than a duplicate) are listed but not scored.</li>
  </ol>
</section>
<section class="blk prose" id="never">
  <div class="blk-h"><h2>What it never does</h2></div>
  <ul>
    <li>It never sends a POST, PUT, PATCH, DELETE or a beacon to the site. Every request other than GET, while the page loads and
    during the probe, is answered inside the browser with a stand-in <code>200</code> JSON reply (or a <code>204</code> for a form
    navigation, so the page stays put) and never leaves it. Form data that the page's own script sends with GET does reach the
    site's own origin.</li>
    <li>It never follows a link off the page: after the first load, any navigation of the page is cancelled. It opens no new
    windows or tabs: <code>window.open</code> does nothing, and forms and links that would open one stay in the page.</li>
    <li>While it clicks, requests for data to other origins are cancelled and WebSocket messages are held.</li>
    <li>It never signs in, never types into anything but a search box, and registers no service workers. The double-click
    probe submits the form empty, with the browser's own form validation turned off.</li>
    <li>It does not load private addresses. IP addresses in private, loopback, link-local, carrier-grade NAT and metadata ranges,
    and local names, are blocked for every request. Every hostname the page asks for is looked up in DNS first, and a name that
    points to a private address is not loaded; a redirect also has to pass the opt-out list and <code>robots.txt</code>.
    WebSocket connections to IP addresses or local names are refused, and a WebSocket host that resolves to a private address
    throws the scan away. The browser then looks each name up again itself, so a DNS server that gives a different answer the
    second time is the one case these checks cannot rule out.</li>
  </ul>
</section>
<section class="blk prose" id="ua">
  <div class="blk-h"><h2>User agent</h2></div>
  <p>Every request carries the token <code>${esc(UA_TOKEN)}</code> at the end of a normal Chrome user agent:</p>
  <pre>${esc(userAgent("131", false))}\n${esc(userAgent("131", true))}</pre>
  <p>Requests come from Cloudflare's Browser Rendering network, which identifies them as automated.</p>
</section>
<section class="blk prose" id="limits">
  <div class="blk-h"><h2>Limits</h2></div>
  <ul>
    <li>Five new scans per minute per visitor, and one running at a time (cached results do not count). Visitors on IPv6 count
    by their /64 network.</li>
    <li>A few new scans per minute per site, whoever asks, and a small number of scans at once across everyone.</li>
    <li>Crawlers and link previews can open a report but cannot start a scan.</li>
    <li>One scan per address at a time; a second request for the same address waits for the first result.</li>
  </ul>
</section>
<section class="blk" id="score">
  <div class="blk-h"><h2>How the score works</h2><span class="aside">${esc(SCORE_VERSION)}</span></div>
  <p class="intro">The score starts at 100. Each finding takes points by its severity; each category can lose at most its cap, so one noisy
  category cannot take the page to zero. The same page with the same findings always gets the same score.</p>
  <div class="formula">score = 100 &minus; &Sigma;<sub>category</sub> min(cap, &Sigma;<sub>findings in it</sub> points(severity))<br>
  points: high ${SEVERITY_POINTS.high}, medium ${SEVERITY_POINTS.medium}, low ${SEVERITY_POINTS.low} &middot; cap: 25 per category &middot; four categories</div>
  <div class="two">
    <div><table class="dt"><thead><tr><th>Category</th><th class="r">Cap</th></tr></thead><tbody>${cats}</tbody></table>
    <figcaption>Table 1. Categories and the most each can take.</figcaption></div>
    <div><table class="dt"><thead><tr><th>Finding</th><th>Category</th><th>Severity</th><th class="r">Points</th></tr></thead><tbody>${kinds}</tbody></table>
    <figcaption>Table 2. Every kind of finding, its category and weight. The same element with the same problem in two views counts once.</figcaption></div>
  </div>
  <div class="prose">
  <p>The checks are the GenClass runtime's measured visual checks, 23 kinds with fixed thresholds (Table 2): text under 1.5:1
  contrast on a background it can measure (text over images, gradients or video is skipped), <code>[object Object]</code>,
  <code>$NaN</code> or raw <code>{{ }}</code> placeholders in visible text, lorem ipsum, garbled characters, images, background
  images, video, stylesheets, fonts and icon fonts that failed, files the Content-Security-Policy blocked, CSS variables defined
  nowhere, stretched images, sideways scrolling, a missing viewport meta tag on phones, layout shifts above 0.25, an empty main
  region, a page that ignores clicks or cannot scroll, controls under fixed bars, focus hidden under sticky bars, and dialogs that
  are covered. Each finding says what was measured and against which threshold.</p>
  <p>How often they are right, as measured for the runtime (GitHub runners, Chromium, 2026-10-13): on its fixture pages, 35 of
  35 planted faults found across the 23 kinds; on its bench, no false reports in 128 page views of clean local apps, and every
  planted fault in real app layouts found for 19 of the 23 kinds; on 40 public home pages, 8 findings in 96 loads, 5 of them
  confirmed real and none shown wrong (the other 3 unconfirmed). The checks in this scanner are that build. Details are in the
  runtime's RESULTS.md, sections 8 and 9.</p>
  <h3 class="h3">The with-GenClass score</h3>
  <p>It is measured, never projected. In the same browser, the visual checks run in guard mode with their fixes on, as
  <code>GenClass.init({ mode: "guard", visual: { on: true, fix: true } })</code> runs them, and a second set of the same checks,
  report-only, measures the page again with the fixes in place. GenClass fixes three kinds in the page: text colour for
  invisible text, a leaked inline <code>pointer-events: none</code> and a leaked inline scroll lock on html or body. A finding
  counts as fixed only when GenClass applied its fix and the re-check no longer found it, in every view where it appeared.
  Every other kind is reported for the developer with the suggested CSS or code, and the report says so on each finding. The
  race probe runs again in a fresh page with GenClass guard at its default settings; a double submit counts as fixed only when
  guard's own action sent fewer requests. When guard flags a problem but its expected gain does not clear the safety margin, the
  report says it held back.</p>
  </div>
</section>
<section class="blk prose" id="opt-out">
  <div class="blk-h"><h2>Opting out</h2></div>
  <p>Site owners can stop the page check from loading their pages in two ways:</p>
  <ul>
    <li>Add a group to <code>robots.txt</code>. The scanner reads only groups that name it, since a person asked for one page:</li>
  </ul>
  <pre>User-agent: GenClassScan\nDisallow: /</pre>
  <ul>
    <li>Or email <a href="mailto:${OPT_OUT_EMAIL}?subject=GenClassScan%20opt-out">${OPT_OUT_EMAIL}</a> with the hostname. It goes on a
    block list the scanner checks before every scan, every redirect, every report view and every screenshot, subdomains included,
    so cached results and screenshots for it stop showing at once.</li>
  </ul>
</section>
<section class="blk prose" id="retention">
  <div class="blk-h"><h2>What is kept, and for how long</h2></div>
  <ul>
    <li>The report (findings, timings and the address) is cached for 6 hours, so a shared link shows the same result without a new scan.</li>
    <li>Screenshots and reports are deleted 24 hours after the scan by an hourly sweep.</li>
    <li>The visitor's IP address is used only for the per-minute rate limit, as a hash, and is not stored.</li>
    <li>The browser starts empty for every scan and is closed afterwards. No cookies or storage carry over between scans.</li>
  </ul>
</section>
<footer class="dfoot">The page check is part of <a href="https://genclass.dev/">GenClass</a>, an open-source runtime for web apps
(<a href="https://github.com/genclass-dev/GenClass-lib">source</a>). Questions: <a href="mailto:${OPT_OUT_EMAIL}">${OPT_OUT_EMAIL}</a>.</footer>`;
  return shell(n, "How the page check works | GenClass", "about", body, "");
}

// ------------------------------------------------------------------------------------------ errors

export function notFoundPage(n: string): string {
  return shell(
    n,
    "Not found | GenClass page check",
    "scan",
    `<section class="hero"><p class="eyebrow">Page check</p><h1>Nothing here.</h1><p class="lead">Try <a href="/scan">the page check</a>.</p></section>`,
    "",
  );
}
