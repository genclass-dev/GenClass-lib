// HTML for genclass.dev/scan (the URL box, progress and the report), genclass.dev/scan/about (what the scanner does,
// the score formula, opt-out and retention) and the scan worker's error pages. No external scripts: one inline script
// and one inline style per response, each under a fresh CSP nonce. Every dynamic string reaches the page through
// textContent, never innerHTML; data travels in a <script type="application/json"> block escaped by embed().

import { CLS_GOOD, CLS_POOR, FONT_MIN, JUDGE_DPR, LCP_GOOD_MS, LCP_POOR_MS, OVERSIZE_BYTES, OVERSIZE_RATIO, TARGET_MIN } from "./audits.ts";
import { CROP_PAD, FAMILY_WORDS, FIND_THRESHOLD, JUDGE_EVAL, JUDGE_LABEL, JUDGE_MAX_CALLS, JUDGE_MODEL, JUDGE_NAME, JUDGE_PLATFORM, JUDGE_SHARE, JUDGE_TIMEOUT_MS, KEEP_THRESHOLD, VERDICT_WORDS } from "./judge.ts";
import { AXE_OFF, AXE_TAGS } from "./axe.ts";
import { AXE_BUILD } from "./axe-source.ts";
import { KINDS, NOT_RUN_HERE, VISUAL_KINDS, type Kind } from "./catalog.ts";
import { JS_NOTE_BYTES } from "./cdp.ts";
import { SCAN_BUDGET_MS, UA_TOKEN, userAgent, VIEWS } from "./scan.ts";
import { categoryValue, CATEGORIES, INSTANCE_CAP, rulePoints, SCORE_VERSION, SEVERITY_ORDER, SEVERITY_POINTS, type Severity } from "./score.ts";
import { safeStandardUrl } from "./standards.ts";
import { RUNTIME_VERSION, visualStatus } from "./visual.ts";
import { VISUAL_BUILD } from "./visual-source.ts";

export const INSTALL_LINE = `<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@${RUNTIME_VERSION}" data-mode="guard"></script>`;

/** The with-GenClass column's label: it says the visual fixes are in testing until a released runtime has them. */
export function withLabel(): string {
  return visualStatus().shipped ? "With GenClass on" : "With GenClass (in testing)";
}
export const OPT_OUT_EMAIL = "mehar@daybot.ca";

/** "Visual bugs 25, Accessibility 25, Phone 20, Reliability 15, Speed 10, Races 5", from the score's own constants. */
export function weightsWords(): string {
  return `weights: ${CATEGORIES.map((c) => `${c.label} ${c.weight}`).join(", ")}`;
}

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
.find .tags .sev-critical,.find .tags .sev-serious{color:var(--bug)}
.find .tags .sev-critical{font-weight:600}
.find dd a{color:var(--ink);text-decoration:underline}
.find dd .ex{display:block;margin-top:4px;font:12.5px var(--mono);color:var(--ink3)}
ol.finds li.catg{display:flex;flex-wrap:wrap;gap:4px 16px;justify-content:space-between;align-items:baseline;padding:36px 0 10px;border-bottom:1px solid var(--ink)}
ol.finds li.catg:first-child{padding-top:16px}
ol.finds li.catg h3{font:700 21px/1.2 var(--display);letter-spacing:-.02em}
ol.finds li.catg span{font:12.5px var(--mono);color:var(--ink3)}
ol.finds li.ruleg{font:500 12.5px var(--mono);color:var(--ink3);padding:16px 0 0}
/* the six categories and the top issues */
.cats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0 24px;margin-top:28px;border-top:1px solid var(--ink)}
.cats .cat{padding:14px 0;border-bottom:1px solid var(--rule);min-width:0}
.cats .k{font:500 11.5px var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--ink3)}
.cats .v{font:700 36px/1.1 var(--display);letter-spacing:-.03em;font-variant-numeric:tabular-nums;margin-top:6px}
.cats .v small{font:500 13px var(--mono);letter-spacing:0;color:var(--ink3);margin-left:3px}
.cats .s{font-size:12.5px;line-height:1.45;color:var(--ink3);margin-top:4px}
.cats .off .v{font-size:17px;line-height:1.5;color:var(--ink3);letter-spacing:0}
@media (max-width:900px){.cats{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:480px){.cats{grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.cats .v{font-size:30px}}
ol.top{list-style:none;margin-top:4px;max-width:900px}
ol.top li{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:4px 16px;padding:12px 0;border-bottom:1px solid var(--rule);align-items:baseline}
ol.top .no{font:600 13px/26px var(--mono);color:#0B1736;background:var(--bug-f);border-radius:2px;width:30px;height:26px;text-align:center;text-decoration:none}
ol.top b{font-weight:600}
ol.top .m{display:block;font:12.5px var(--mono);color:var(--ink3);margin-top:2px}
ol.top .p{font:600 13.5px var(--mono);color:var(--bug);font-variant-numeric:tabular-nums;white-space:nowrap}
@media (max-width:560px){ol.top li{grid-template-columns:40px minmax(0,1fr)}ol.top .p{grid-column:2}}
.find dl{display:grid;grid-template-columns:minmax(110px,150px) minmax(0,1fr);margin-top:12px;font-size:15px}
.find dt{font:500 12px/1.9 var(--mono);color:var(--ink3);padding:6px 12px 6px 0;border-top:1px solid var(--rule)}
.find dd{padding:6px 0;border-top:1px solid var(--rule);color:var(--ink2);min-width:0;overflow-wrap:anywhere}
.find dd code{font:13.5px var(--mono);color:var(--ink)}
.find pre{background:var(--code);color:var(--codeink);border-radius:8px;padding:10px 12px;font:13px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.find .gc-yes{color:var(--green);font-weight:600}
.find .show{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
@media (max-width:560px){.find{grid-template-columns:1fr}.find dl{grid-template-columns:1fr}.find dt{border-top:0;padding-bottom:0}}
.quiet{padding:28px 0;color:var(--ink2)}
/* the model judge: the crops it saw, the element's box outlined */
.crops{display:flex;flex-wrap:wrap;gap:12px 16px;margin-top:10px}
.crop{margin:0;min-width:0;max-width:100%}
.cropbox{position:relative;display:inline-block;max-width:min(100%,360px);line-height:0}
.crop img{display:block;width:100%;height:auto;border:1px solid var(--rule2);border-radius:2px;background:var(--panel)}
.cropbox i{position:absolute;border:2px solid var(--bug-f);border-radius:2px;pointer-events:none}
.crop figcaption{margin-top:6px}
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
.notrun{display:block;font:12px var(--mono);color:var(--ink3);margin-top:2px}
.mt{margin-top:28px}
/* narrow screens: a visible gap between the number columns, and number tags beside their boxes, not over the text */
@media (max-width:560px){
  table.dt th.r,table.dt td.r{padding-left:10px}
  table.dt th,table.dt th.r{font-size:10.5px;letter-spacing:.02em;white-space:normal}
  .frame .mark.in:not(.low) a{left:0;top:auto;bottom:100%;margin:0 0 2px}
}
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
<meta name="description" content="Check one public page for visual bugs, accessibility (axe-core, WCAG 2.2 A and AA), phone layout, errors, speed and double-submit races. Requests that could change something on the site are never sent.">
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
  ["Some checks need a known background.", `Text over images, gradients or video is skipped by the measured contrast check rather than guessed at. A model (${JUDGE_NAME}) looks at crops of some of these; what it finds is labelled as judged by a model, not measured.`],
  ["A model's judgement is not a measurement.", `Findings labelled "${JUDGE_LABEL}" come from a crop of the screenshot. On its evaluation ${JUDGE_EVAL.find.real} of ${JUDGE_EVAL.find.flagged} such findings were real problems, by labels that AI agents made; look at the crop before acting on one.`],
  ["No clicks on the page.", "The scanner presses Tab and scrolls, but clicks only the probe's submit button, so checks that need a visitor's clicks (an invisible layer that swallows them) do not run here."],
  ["Six seconds per view.", "Problems that appear later, after a timer or a second interaction, are not seen."],
  ["Timings from a data center.", "Largest Contentful Paint and layout shift are measured once, in Cloudflare's browser with a fast network, three views loading at once and GenClass loading in the desktop view. A visitor's numbers can be better or worse; field data (Chrome's CrUX) is the reference."],
  ["Automated accessibility checks find some problems, not all.", "axe-core reports what it can decide by itself. Whether alt text is meaningful, whether the page works with a screen reader or the keyboard alone, still needs a person."],
  ["Bot protection.", "Some sites show a challenge page to automated browsers. The report then describes that page, not the site."],
];

/** What the "listed, not scored (a model judged it as probably fine)" list is, in words. */
export const JUDGE_FINE_INTRO = `These are measured findings. A model (${JUDGE_NAME}, on ${JUDGE_PLATFORM}) looked at a crop of the screenshot and judged each as probably fine in every view it appeared in, so they are not scored. Each is shown as it was measured, with the crop the model saw: look before deciding.`;

/** A crop's URL from stored data: only this origin's screenshot path for a judged element. */
export const CROP_URL = /^\/api\/scan\/shot\/[0-9a-f]{32}\/[0-9a-z]{6,40}-(?:desktop|phone|phone-dark)-j[1-9]\d?\.jpg$/;

export function scanPage(n: string, data: ScanPageData): string {
  const t = data.target;
  const st = visualStatus();
  const report = data.report && typeof data.report === "object" ? (data.report as Record<string, unknown>) : null;
  const errorDetail = data.error && (data.error.code === "robots" || data.error.code === "opted-out") ? "Site owners can opt out of the page check; this site has." : "";
  const body = `
<script type="application/json" id="data">${embed({ ...data, status: { withLabel: withLabel(), fixes: st.fixes, shipped: st.shipped, runtime: RUNTIME_VERSION, judge: { label: JUDGE_LABEL, verdicts: VERDICT_WORDS, families: FAMILY_WORDS } } })}</script>
<section class="hero">
  <p class="eyebrow">Page check</p>
  <h1 id="title">${t ? esc(t.display) : "What breaks on one page load."}</h1>
  <div class="meta" id="meta">${report ? staticMeta(report) : ""}</div>
  <form class="urlbox" action="/scan" method="get" role="search">
    <label class="sr" for="u">Address of a public page</label>
    <input id="u" name="url" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="2048" placeholder="example.com/pricing" value="${esc(data.input)}">
    <button class="btn" id="go" type="submit">Check page</button>
  </form>
  <p class="lead" id="lead"${t ? ' hidden' : ""}>Paste an address. A browser loads the page on a desktop and on a phone, light and dark, and
  checks it six ways: visual bugs (${esc(st.checks)}), accessibility (axe-core's WCAG 2.2 A and AA rules), the phone layout
  (tap targets, zoom, text size, sideways scrolling at 320 px), errors and failed requests, speed (Largest Contentful Paint and
  layout shift), and races: it types into the search box and double-clicks a submit button with GenClass ${esc(RUNTIME_VERSION)}
  watching. Requests that could change something on the site are answered inside the browser and never sent. A model
  (${esc(JUDGE_NAME)}, on ${esc(JUDGE_PLATFORM)}) takes a second look at crops of the screenshots; what it finds is labelled as judged,
  not measured.</p>
</section>
${t && !report && !data.error ? `<noscript><section class="callout"><p><b>The page check runs in your browser with JavaScript.</b></p><p class="muted">Turn JavaScript on to check this page, or read <a href="/scan/about">how the page check works</a>.</p></section></noscript>` : ""}
${report ? staticReport(report) : ""}
<section id="progress" class="hidden" aria-live="polite">
  <ol class="steps" id="steps"></ol>
  <p class="elapsed" id="elapsed"></p>
</section>
<section id="problem" class="callout bad${data.error ? "" : " hidden"}" role="alert"><p><b id="problemt">${data.error ? esc(data.error.message) : ""}</b></p><p id="problemd" class="muted">${esc(errorDetail)}</p></section>
<div id="result" class="hidden">
  <section class="scoregrid" id="scorebox" aria-labelledby="sh">
    <div>
      <h2 class="sr" id="sh">Score</h2>
      <div class="nums">
        <div class="num"><div class="k" id="sk">Score</div><div class="v"><span id="sv"></span><small>/ 100</small></div><div class="s" id="ss"></div></div>
        <div class="num with hidden" id="withbox"><div class="k">${esc(withLabel())}</div><div class="v"><span id="wv"></span><small>/ 100</small></div><div class="s" id="ws"></div></div>
      </div>
    </div>
    <div>
      <p class="measures">The weighted mean of six category scores (${esc(weightsWords())}); a category that was not measured is left
      out. <a href="/scan/about#score">How the score works</a>.</p>
      <div class="share" id="share"></div>
    </div>
  </section>
  <div class="cats" id="cats" role="list" aria-label="Category scores"></div>
  <section class="blk hidden" id="topbox">
    <div class="blk-h"><h2>Top issues</h2><span class="aside">The rules that cost the most points</span></div>
    <ol class="top" id="top"></ol>
  </section>
  <p class="measures" id="measures"><b>What the score measures:</b> this page, this one load, in three views, each category from 100
  by its own findings. <b>What it does not measure:</b> SEO, anything that needs a signed-in user or a second page, and what only a
  person can judge.</p>
  <section class="blk" id="where">
    <div class="blk-h"><h2>Where the findings are</h2><span class="aside" id="figs"></span></div>
    <div class="shots" id="shots"></div>
  </section>
  <section class="blk" id="list">
    <div class="blk-h"><h2>Findings</h2><span class="aside" id="listn"></span></div>
    <ol class="finds" id="finds"></ol>
    <p class="quiet hidden" id="none">No findings from these checks on this load. That is a good sign for these checks only; see what one load cannot show, below.</p>
    <p class="measures" id="judgenote"></p>
  </section>
  <section class="blk hidden" id="judgedfine">
    <div class="blk-h"><h2>Listed, not scored (a model judged it as probably fine)</h2><span class="aside" id="finen"></span></div>
    <p class="intro">${esc(JUDGE_FINE_INTRO)}</p>
    <ol class="finds" id="finefinds"></ol>
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
    response when the expected gain clears its safety margin.<span id="ctaprobe"${report ? "" : ' class="hidden"'}> The race probe above shows whether it did on this page.</span>
    ${
      st.shipped
        ? `The visual checks ship in runtime ${esc(String(RUNTIME_VERSION))}: <code>visual: { on: true }</code> runs them, and with <code>fix: true</code> in guard mode it also fixes invisible text, a leaked <code>pointer-events: none</code> and a leaked scroll lock.`
        : `The visual checks on this page are built for the runtime and in testing for a release after ${esc(RUNTIME_VERSION)}; runtime ${esc(RUNTIME_VERSION)} does not have them yet.`
    }</p>
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
deleted after 24 hours. Crops of the screenshots go to ${esc(JUDGE_PLATFORM)} for the model judge (<a href="/scan/about#judge">what is sent</a>).
Site owners can opt out: <a href="/scan/about#opt-out">how</a>. <a href="/scan/about">How the score works</a>.</footer>`;
  return shell(n, t ? `${t.display} | GenClass page check` : "Page check | GenClass", "scan", body, CLIENT_JS);
}

// The cached report as static HTML, for a browser without JavaScript (the script replaces it with the full report).
// Every value goes through esc(); the report is read defensively, since it comes from storage.

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const VIEW_WORDS: Record<string, string> = { desktop: "Desktop", phone: "Phone", "phone-dark": "Phone, dark", probe: "Race probe" };
const CAT_WORDS: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
const SEV_WORDS: Record<string, string> = { critical: "Critical", serious: "Serious", moderate: "Moderate", minor: "Minor" };

function staticMeta(r: Record<string, unknown>): string {
  const at = Date.parse(str(r.scannedAt));
  const total = int(obj(r.ms).total);
  return [
    str(r.url),
    Number.isFinite(at) ? `Scanned ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "",
    total !== null ? `${(total / 1000).toFixed(1)} s in total` : "",
    str(r.runtime) ? `@genclass/runtime ${str(r.runtime)}` : "",
    str(r.axe) ? `axe-core ${str(r.axe)}` : "",
  ]
    .filter(Boolean)
    .map((x) => `<span>${esc(x)}</span>`)
    .join("");
}

/** A standard's link from stored data: only to the standards' own sites (standards.ts safeStandardUrl). */
function standardLinks(v: unknown): string {
  return arr(v)
    .map(obj)
    .map((s) => {
      const url = safeStandardUrl(s.url);
      const label = str(s.label);
      return label ? (url ? `<a href="${esc(url)}">${esc(label)}</a>` : esc(label)) : "";
    })
    .filter(Boolean)
    .join("<br>");
}

export function staticReport(r: Record<string, unknown>): string {
  const score = obj(r.score);
  const w = obj(r.withGenClass);
  const withOn = w.shown === true && int(w.value) !== null;
  const everything = arr(r.findings).map(obj);
  const isFine = (f: Record<string, unknown>) => str(obj(f.judge).outcome) === "fine";
  const findings = everything.filter((f) => !isFine(f));
  const fine = everything.filter(isFine);
  const withCats = arr(obj(w.breakdown).categories).map(obj);
  const notMeasured = obj(r.notMeasured);
  const cats = arr(score.categories).map(obj);
  const cells = cats
    .map((c) => {
      const on = c.measured === true && int(c.value) !== null;
      const wc = withCats.find((x) => str(x.id) === str(c.id));
      const withDiff = withOn && wc && int(wc.value) !== null && int(wc.value) !== int(c.value) ? ` · ${esc(withLabel())} ${esc(str(wc.value))}` : "";
      const review = int(obj(r.metrics).axeIncomplete) ?? 0;
      const needsReview = str(c.id) === "accessibility" && review > 0 ? ` · ${review} ${review === 1 ? "rule needs" : "rules need"} review, not scored` : "";
      const sub = on ? `weight ${esc(str(c.weight))} · ${int(c.count) ? `${esc(str(c.count))} ${int(c.count) === 1 ? "finding" : "findings"}` : "nothing found"}${withDiff}${needsReview}` : esc(str(notMeasured[str(c.id)]) || "Not measured on this scan.");
      return `<div class="cat${on ? "" : " off"}" role="listitem"><div class="k">${esc(str(c.label))}</div><div class="v">${on ? `${esc(str(c.value))}<small>/ 100</small>` : "not measured"}</div><div class="s">${sub}</div></div>`;
    })
    .join("");
  const top = arr(r.top)
    .map(obj)
    .map(
      (t) =>
        `<li><a class="no" href="#sf-${esc(str(t.n))}">${esc(str(t.n))}</a><div><b>${esc(str(t.what))}</b><span class="m">${esc(CAT_WORDS[str(t.category)] ?? "")} · ${esc(SEV_WORDS[str(t.severity)] ?? "")}${(int(t.count) ?? 0) > 1 ? ` · ${esc(str(t.count))} instances` : ""}</span></div><span class="p">-${esc(((typeof t.points === "number" ? t.points : 0) as number).toFixed(1))}</span></li>`,
    )
    .join("");
  const ruleCount = new Map<string, number>();
  for (const f of findings) ruleCount.set(`${str(f.category)}|${str(f.rule)}`, (ruleCount.get(`${str(f.category)}|${str(f.rule)}`) ?? 0) + 1);
  let lastCat = "";
  let lastRule = "";
  const items = findings
    .map((f) => {
      const cat = str(f.category);
      let head = "";
      if (cat !== lastCat) {
        const c = cats.find((x) => str(x.id) === cat);
        head += `<li class="catg"><h3>${esc(CAT_WORDS[cat] ?? cat)}</h3><span>${c && c.measured === true ? `${esc(str(c.value))} / 100` : "not measured"}</span></li>`;
        lastCat = cat;
        lastRule = "";
      }
      const rk = `${cat}|${str(f.rule)}`;
      if ((ruleCount.get(rk) ?? 0) > 1 && str(f.rule) !== lastRule) head += `<li class="ruleg">${esc(str(f.what))}: ${esc(String(ruleCount.get(rk)))} findings</li>`;
      lastRule = str(f.rule);
      return head + item(f);
    })
    .join("");
  function item(f: Record<string, unknown>): string {
    const sev = str(f.severity);
    const views = arr(f.views).map((v) => VIEW_WORDS[str(v)] ?? str(v)).filter(Boolean).join(" · ");
    const gc = obj(f.genclass);
    const fixed = obj(f.fixed);
    const row = (k: string, v: string) => (v ? `<dt>${esc(k)}</dt><dd>${v}</dd>` : "");
    const count = int(f.count) ?? 1;
    const byModel = str(f.source) === "judge";
    const j = obj(f.judge);
    // what the model judge said, with the crops it saw (only this origin's crop URLs)
    const crops = arr(j.views)
      .map(obj)
      .map((v) => {
        const url = str(v.crop);
        const size = arr(v.cropSize).map((x) => int(x) ?? 0);
        const said = typeof v.score === "number" && Number.isFinite(v.score) ? `score ${v.score.toFixed(4)}` : "no answer in time";
        const cap = `${VIEW_WORDS[str(v.view)] ?? str(v.view)}: ${said}`;
        return `<figure class="crop">${CROP_URL.test(url) ? `<img src="${esc(url)}" alt="What the model saw, ${esc(cap)}" width="${size[0] || 1}" height="${size[1] || 1}" loading="lazy">` : ""}<figcaption>${esc(cap)}</figcaption></figure>`;
      })
      .join("");
    const judgeRow = str(j.text) ? row(byModel ? "The model" : "Model check", `${esc(str(j.text))}${crops ? `<span class="crops">${crops}</span>` : ""}`) : "";
    const examples = arr(f.examples).map(str).filter((x) => x && x !== str(f.selector));
    const guide = typeof f.guide === "string" && /^https:\/\/dequeuniversity\.com\/rules\/axe\//.test(f.guide) ? f.guide : "";
    const source = byModel ? `<span>${esc(JUDGE_LABEL)}</span>` : "";
    return `<li class="find${withOn && str(fixed.how) ? " fixed" : ""}" id="sf-${esc(str(f.n))}"><div class="no">${esc(str(f.n))}</div><div><h3>${esc(str(f.what))}</h3>
<div class="tags"><span class="sev-${esc(sev)}">${esc(SEV_WORDS[sev] ?? "")}</span>${count > 1 ? `<span>${esc(String(count))} instances</span>` : ""}<span>${esc(views)}</span>${source}${str(f.unscored) ? "<span>Not scored</span>" : ""}</div>
<dl>${row(byModel ? "What the model saw" : "Measured", esc(str(f.measured)))}${judgeRow}${row("Standard", standardLinks(f.standards))}${row("Where", str(f.selector) ? `<code>${esc(str(f.selector))}</code>${examples.length ? `<span class="ex">Also: ${examples.map(esc).join(", ")}</span>` : ""}` : "")}${row("Not scored", esc(str(f.unscored)))}${row("Why it matters", esc(str(f.why)))}${row("Suggested fix", str(f.fix) ? `<pre>${esc(str(f.fix))}</pre>` : "")}${row("Rule guide", guide ? `<a href="${esc(guide)}">${esc(guide.replace(/^https:\/\//, "").replace(/\?.*$/, ""))}</a>` : "")}${withOn ? row("With GenClass", esc(str(fixed.how) ? `Fixed. ${str(fixed.how)}` : str(gc.text))) : ""}</dl></div></li>`;
  }
  const judgeNote = str(obj(r.judge).note);
  const fineBlock = fine.length
    ? `<section class="blk"><div class="blk-h"><h2>Listed, not scored (a model judged it as probably fine)</h2><span class="aside">${fine.length} ${fine.length === 1 ? "finding" : "findings"}</span></div><p class="intro">${esc(JUDGE_FINE_INTRO)}</p><ol class="finds">${fine.map(item).join("")}</ol></section>`
    : "";
  const n = findings.filter((f) => !str(f.unscored)).length;
  const overall = int(score.value);
  return `<div id="ssr">
<section class="scoregrid" aria-label="Score">
  <div><div class="nums">
    <div class="num"><div class="k">${withOn ? "Without GenClass" : "Score"}</div><div class="v">${overall !== null ? esc(String(overall)) : "n/a"}<small>/ 100</small></div><div class="s">${n ? `${n} scored ${n === 1 ? "finding" : "findings"}.` : "No scored findings from these checks."}</div></div>
    ${withOn ? `<div class="num with"><div class="k">${esc(withLabel())}</div><div class="v">${esc(str(w.value))}<small>/ 100</small></div><div class="s">${esc(str(w.fixed))} fixed in the page and gone on a re-check in the same browser.</div></div>` : ""}
  </div></div>
  <div>
    <p class="measures">The weighted mean of six category scores (${esc(weightsWords())}); a category that was not measured is left out. Screenshots and the race probe show with JavaScript on. <a href="/scan/about#score">How the score works</a>.</p>
  </div>
</section>
<div class="cats" role="list" aria-label="Category scores">${cells}</div>
${top ? `<section class="blk"><div class="blk-h"><h2>Top issues</h2><span class="aside">The rules that cost the most points</span></div><ol class="top">${top}</ol></section>` : ""}
${withOn ? `<p class="measures">${esc(str(w.note))}</p>` : ""}
<section class="blk"><div class="blk-h"><h2>Findings</h2><span class="aside">Table 1. ${findings.length} ${findings.length === 1 ? "finding" : "findings"}, by category and rule</span></div>
${findings.length ? `<ol class="finds">${items}</ol>` : `<p class="quiet">No findings from these checks on this load.</p>`}${judgeNote ? `<p class="measures">${esc(judgeNote)}</p>` : ""}</section>
${fineBlock}
</div>`;
}

// The client: progress over the NDJSON stream, then the report. textContent only.
const CLIENT_JS = `(function(){
"use strict";
var D = JSON.parse(document.getElementById("data").textContent);
var ST = D.status || {};
var ssr = document.getElementById("ssr"); if (ssr && ssr.parentNode) ssr.parentNode.removeChild(ssr);
var $ = function(id){ return document.getElementById(id); };
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
function show(id, on){ $(id).classList.toggle("hidden", !on); }
var nf = new Intl.NumberFormat("en-US");
function secs(ms){ return (Math.round(ms / 100) / 10).toFixed(1) + " s"; }
var STEPS = [["check","Checking the address and robots.txt"],["browser","Starting a browser"],["views","Loading the page: desktop, phone, phone dark"],["checks", (ST.shipped ? "Running the GenClass visual checks" : "Running the visual checks (in testing)") + ", axe-core and the phone audits, taking screenshots, and asking a model (Clef) about crops of them"],["probe","Race probe: typing and a double click, GenClass in observe mode"],["guard","The same probe with GenClass in guard mode"],["save","Scoring and saving the report"]];
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
  timer = setInterval(function(){ $("elapsed").textContent = secs(Date.now() - t0) + " elapsed. A scan usually takes 20 to 45 seconds."; }, 200);
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
var retried = false, contended = 0;
function refused(status, j){
  var code = j && j.code;
  if (code === "in-progress") { progress("views"); return poll(0); }
  // many scans starting at once: the slots may be free, so try again shortly, a few times
  if (code === "contention" && contended < 4) { contended++; return setTimeout(start, 2000 + Math.floor(Math.random() * 2000)); }
  if (j && j.report) return done(j.report);
  var title = (j && j.message) || ("The scanner answered HTTP " + status + ".");
  var detail = code === "rate" ? "Each visitor can start five new scans a minute. Results are cached for 6 hours, so a shared link does not start a new scan."
    : code === "site-rate" ? "Each site can have a few new scans started a minute, whoever asks. Try again in a minute."
    : code === "running" ? "Each visitor can run one scan at a time. Try again when it has finished."
    : code === "contention" ? "Many scans are starting at once. Try again in a few seconds."
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
  [r.url, "Scanned " + new Date(r.scannedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }), secs(r.ms.total) + " in total", "@genclass/runtime " + r.runtime, r.axe ? "axe-core " + r.axe : ""].forEach(function(t){ if (t) meta.appendChild(el("span", null, t)); });
  renderScore(r); renderShots(r); renderFindings(r); renderProbe(r); renderShare(r);
  show("ctaprobe", true);
  if (history.replaceState && D.target) { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {} }
}

var CATNAME = { visual: "Visual bugs", accessibility: "Accessibility", phone: "Phone", reliability: "Reliability", speed: "Speed", races: "Races" };
var SEVNAME = { critical: "Critical", serious: "Serious", moderate: "Moderate", minor: "Minor" };
var SOURCENAME = { visual: ST.shipped ? "GenClass visual check" : "GenClass visual check (in testing)", axe: "axe-core", audit: "Scanner audit", probe: "Race probe", judge: (ST.judge && ST.judge.label) || "Judged by a model" };
var STD_HOSTS = /^https:\\/\\/(?:www\\.w3\\.org|web\\.dev|developer\\.chrome\\.com|www\\.rfc-editor\\.org|github\\.com\\/dequelabs|dequeuniversity\\.com)\\//;
function catIn(b, id){ var cs = (b && b.categories) || []; for (var i = 0; i < cs.length; i++) if (cs[i].id === id) return cs[i]; return null; }
function renderScore(r){
  var s = r.score;
  $("sv").textContent = s.value === null || s.value === undefined ? "n/a" : String(s.value);
  var scored = r.findings.filter(function(f){ return !f.unscored; }), n = scored.length, extra = r.findings.length - n;
  var rules = {}; scored.forEach(function(f){ rules[f.category + "|" + f.rule] = 1; });
  var nr = Object.keys(rules).length;
  $("ss").textContent = (n ? nf.format(n) + (n === 1 ? " scored finding" : " scored findings") + " in " + nr + (nr === 1 ? " rule" : " rules") + ". The categories below show where the points went." : "No scored findings from these checks.")
    + (extra ? " " + extra + (extra === 1 ? " more is" : " more are") + " listed but not scored." : "");
  var w = r.withGenClass, withOn = !!(w && w.shown);
  show("withbox", withOn);
  $("sk").textContent = withOn ? "Without GenClass" : "Score";
  if (withOn) { $("wv").textContent = String(w.value); $("ws").textContent = (n ? w.fixed + " of " + n + (n === 1 ? " finding" : " findings") + " fixed in the page by GenClass and gone on a re-check in the same browser. The note under the top issues says how." : "Nothing to fix on this load."); }
  var row = $("cats"); row.textContent = "";
  s.categories.forEach(function(c){
    var on = c.measured && c.value !== null;
    var cell = el("div", "cat" + (on ? "" : " off")); cell.setAttribute("role", "listitem");
    cell.appendChild(el("div", "k", c.label));
    var v = el("div", "v", on ? String(c.value) : "not measured"); if (on) v.appendChild(el("small", null, "/ 100")); cell.appendChild(v);
    var wc = withOn ? catIn(w.breakdown, c.id) : null;
    cell.appendChild(el("div", "s", on ? "weight " + c.weight + " · " + (c.count ? c.count + (c.count === 1 ? " finding" : " findings") : "nothing found") + (wc && wc.value !== null && wc.value !== c.value ? " · " + ST.withLabel + " " + wc.value : "") + (c.id === "accessibility" && r.metrics && r.metrics.axeIncomplete ? " · " + r.metrics.axeIncomplete + (r.metrics.axeIncomplete === 1 ? " rule needs" : " rules need") + " review, not scored" : "") : ((r.notMeasured && r.notMeasured[c.id]) || "Not measured on this scan.")));
    row.appendChild(cell);
  });
  var top = $("top"); top.textContent = "";
  (r.top || []).forEach(function(t){
    var li = el("li"), a = el("a", "no", String(t.n)); a.href = "#f-" + t.n; li.appendChild(a);
    var d = el("div"); d.appendChild(el("b", null, t.what));
    d.appendChild(el("span", "m", (CATNAME[t.category] || t.category) + " · " + (SEVNAME[t.severity] || t.severity) + (t.count > 1 ? " · " + nf.format(t.count) + " instances" : "")));
    li.appendChild(d); li.appendChild(el("span", "p", "-" + Number(t.points).toFixed(1)));
    top.appendChild(li);
  });
  show("topbox", (r.top || []).length > 0);
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
        var m = el("div", "mark" + (b.x < 0.06 * v.width ? " in" + (b.y < 24 ? " low" : "") : ""));
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
var JW = ST.judge || { label: "", verdicts: {}, families: {} };
var CROP_URL = /^\\/api\\/scan\\/shot\\/[0-9a-f]{32}\\/[0-9a-z]{6,40}-(?:desktop|phone|phone-dark)-j[1-9]\\d?\\.jpg$/;
function pct(p){ return Math.round(Number(p) * 100) + "%"; }
function isFine(f){ return !!(f.judge && f.judge.outcome === "fine"); }
function renderFindings(r){
  var host = $("finds"); host.textContent = "";
  var fineHost = $("finefinds"); fineHost.textContent = "";
  var list = r.findings.filter(function(f){ return !isFine(f); }), fine = r.findings.filter(isFine);
  show("none", !list.length);
  var withOn = !!(r.withGenClass && r.withGenClass.shown);
  var nfix = list.filter(function(f){ return f.fixed; }).length;
  $("listn").textContent = list.length ? "Table 1. " + list.length + (list.length === 1 ? " finding" : " findings") + ", by category and rule" + (withOn ? ". " + nfix + " fixed in this scan, " + (list.length - nfix) + " not fixed" : "") : "Table 1. No findings";
  $("judgenote").textContent = (r.judge && r.judge.note) || "";
  var ruleN = {}; list.forEach(function(f){ var k = f.category + "|" + f.rule; ruleN[k] = (ruleN[k] || 0) + 1; });
  var lastCat = null, lastRule = null;
  list.forEach(function(f){
    if (f.category !== lastCat) {
      lastCat = f.category; lastRule = null;
      var c = catIn(r.score, f.category), h = el("li", "catg");
      h.appendChild(el("h3", null, CATNAME[f.category] || f.category));
      h.appendChild(el("span", null, c && c.measured ? c.value + " / 100" : "not measured"));
      host.appendChild(h);
    }
    var rk = f.category + "|" + f.rule;
    if (ruleN[rk] > 1 && f.rule !== lastRule) host.appendChild(el("li", "ruleg", f.what + ": " + ruleN[rk] + " findings"));
    lastRule = f.rule;
    host.appendChild(findItem(r, f, withOn));
  });
  fine.forEach(function(f){ fineHost.appendChild(findItem(r, f, withOn)); });
  show("judgedfine", fine.length > 0);
  $("finen").textContent = fine.length + (fine.length === 1 ? " finding" : " findings");
}
// what the model judge said about a finding, and the crops it saw (the element's box outlined in each)
function judgeBlock(f){
  var j = f.judge, out = el("div");
  out.appendChild(el("span", null, j.text));
  var crops = el("div", "crops");
  (j.views || []).forEach(function(v){
    var fig = el("figure", "crop");
    var cw = (v.cropSize && v.cropSize[0]) || 1, ch = (v.cropSize && v.cropSize[1]) || 1, b = v.inCrop || [0, 0, 0, 0];
    if (v.crop && CROP_URL.test(v.crop)) {
      var box = el("div", "cropbox");
      var img = el("img"); img.src = v.crop; img.width = cw; img.height = ch; img.loading = "lazy";
      img.alt = "What the model saw: the " + (VIEWNAMES[v.view] || v.view).toLowerCase() + " view around " + (f.selector || "the element");
      box.appendChild(img);
      var m = el("i"), x = Math.max(0, b[0]), y = Math.max(0, b[1]);
      m.style.left = (100 * x / cw) + "%"; m.style.top = (100 * y / ch) + "%";
      m.style.width = (100 * Math.max(0, Math.min(b[2] - (x - b[0]), cw - x)) / cw) + "%"; m.style.height = (100 * Math.max(0, Math.min(b[3] - (y - b[1]), ch - y)) / ch) + "%";
      box.appendChild(m); fig.appendChild(box);
    }
    var said = v.score === null || v.score === undefined ? "no answer in time"
      : "score " + Number(v.score).toFixed(4) + " · " + (j.outcome === "fine" ? "looks fine " + pct(v.fineP) : (v.verdict ? (JW.verdicts[v.verdict] || v.verdict) + " " + pct(v.verdictP) : "something is wrong")) + " · nothing wrong " + pct(v.noneP);
    fig.appendChild(el("figcaption", null, (VIEWNAMES[v.view] || v.view) + ": " + said));
    crops.appendChild(fig);
  });
  out.appendChild(crops);
  return out;
}
function findItem(r, f, withOn){
    var li = el("li", "find" + (withOn && f.fixed ? " fixed" : "")); li.id = "f-" + f.n;
    li.appendChild(el("div", "no", String(f.n)));
    var main = el("div");
    main.appendChild(el("h3", null, f.what));
    var tags = el("div", "tags");
    tags.appendChild(el("span", "sev-" + f.severity, SEVNAME[f.severity] || f.severity));
    if (f.count > 1) tags.appendChild(el("span", null, nf.format(f.count) + " instances"));
    tags.appendChild(el("span", null, f.views.map(function(v){ return VIEWNAMES[v] || v; }).join(" · ")));
    tags.appendChild(el("span", null, f.source === "axe" && r.axe ? "axe-core " + r.axe : (SOURCENAME[f.source] || "")));
    if (f.judge && f.source !== "judge") tags.appendChild(el("span", null, f.judge.outcome === "kept" ? "A model agreed" : f.judge.outcome === "fine" ? "A model: probably fine" : "A model: no answer"));
    if (f.unscored) tags.appendChild(el("span", null, "Not scored"));
    main.appendChild(tags);
    var dl = el("dl");
    function row(k, node){ dl.appendChild(el("dt", null, k)); var dd = el("dd"); if (typeof node === "string") dd.textContent = node; else dd.appendChild(node); dl.appendChild(dd); return dd; }
    function link(href, text){ var a = el("a", null, text); a.href = href; return a; }
    row(f.source === "judge" ? "What the model saw" : "Measured", f.measured);
    if (f.judge) row(f.source === "judge" ? "The model" : "Model check", judgeBlock(f));
    var stds = (f.standards || []).filter(function(s){ return s && s.label; });
    if (stds.length) { var sd = el("span"); stds.forEach(function(s, i){ if (i) sd.appendChild(el("br")); sd.appendChild(STD_HOSTS.test(String(s.url || "")) ? link(s.url, s.label) : el("span", null, s.label)); }); row("Standard", sd); }
    if (f.selector) {
      var where = el("span"); where.appendChild(el("code", null, f.selector));
      var more = (f.examples || []).filter(function(x){ return x && x !== f.selector; });
      if (more.length) where.appendChild(el("span", "ex", "Also: " + more.join(", ")));
      row("Where", where);
    }
    if (f.unscored) row("Not scored", f.unscored);
    row("Why it matters", f.why);
    var pre = el("pre", null, f.fix); row("Suggested fix", pre);
    if (f.guide && /^https:\\/\\/dequeuniversity\\.com\\/rules\\/axe\\//.test(f.guide)) row("Rule guide", link(f.guide, f.guide.replace(/^https:\\/\\//, "").replace(/\\?.*$/, "")));
    if (withOn) row("With GenClass", f.fixed ? el("span", "gc-yes", "Fixed. " + f.fixed.how) : el("span", null, f.genclass ? f.genclass.text : "Not fixed in this run. The suggested fix above removes it."));
    var shown = Object.keys(f.boxes || {});
    if (shown.length) {
      var bar = el("div", "show");
      shown.forEach(function(v){ var b = el("button", "btn ghost sm", "Show on " + (VIEWNAMES[v] || v).toLowerCase()); b.type = "button"; b.addEventListener("click", function(){ reveal(v, f); }); bar.appendChild(b); });
      row("Screenshot", bar);
    }
    main.appendChild(dl); li.appendChild(main);
    return li;
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
    var req = (o.clicked.requests || [])[0];
    var held = req ? (g.detections || []).filter(function(d){ return d.trigger === "request" && names(d.subject, req.method, req.path) && !d.executed && d.candidate && typeof d.gain === "number" && typeof d.margin === "number"; })[0] : null;
    var dflt = r.probe.guardMargin === null && r.probe.guardAggressiveness === "balanced";
    var WORDS = { duplicate: "a duplicate", stale: "a late response", conflict: "a conflict", inconsistent: "an inconsistency", failing: "a failing request" };
    var gs = g.clicked.identical >= 2 ? g.clicked.identical : g.clicked.sent;
    var sentWords = !gs ? "the page sent nothing" : "the page sent " + (g.clicked.identical >= 2 ? gs + " identical requests" : gs === 1 ? "1 request" : gs + " requests") + " (the scanner answered " + (gs === 1 ? "it; it did not reach" : "them; none reached") + " the site)";
    var MOVES = { coalesce: "merging the two", discard: "dropping it", defer: "holding it back", retry: "retrying it", cancel: "cancelling it" };
    var why = acted ? r.probe.guardClick.how
      : acts.length ? "GenClass did: " + acts.slice(0, 3).join("; ") + ". That did not change what the double click sent."
      : held ? "Flagged, held back at " + (dflt ? "the default safety margin" : "this setting's safety margin") + ": GenClass was " + Math.round(held.p * 100) + "% sure this was " + (WORDS[held.diagnosis] || held.diagnosis) + ", but " + (MOVES[held.candidate] || held.candidate) + " had an expected gain of " + (Math.round(held.gain * 100) / 100) + " against a margin of " + held.margin + ", so it did not act: " + sentWords + "."
      : (g.model || {}).state === "ready" ? "GenClass took no action." : "GenClass took no action: its model did not load in time.";
    row("Guard mode", cmp, "Measured, not projected: the same double click in a fresh page with " + (r.probe.guardSetting || "GenClass in guard mode") + ". " + why);
  } else if (g && g.ran && !triedAny) row("Guard mode", "Nothing to compare", "With nothing to type into or click, guard mode had nothing to change on this page.");
  else if (g && g.ran && o.typed && !o.clicked) row("Guard mode", "Typing only", "The guard pass typed the same letters" + ((g.acts || []).length ? " and GenClass did: " + g.acts.slice(0, 3).map(function(a){ return a.action + ": " + a.changed; }).join("; ") + "." : "; GenClass took no action."));
  else if (g && !g.ran) row("Guard mode", "Not measured", g.note || "");
  else if (!g) row("Guard mode", "Not measured", (r.notes || []).filter(function(n){ return /guard/i.test(n); }).join(" ") || "The guard pass did not run on this scan.");
}

// whether a GenClass subject ("POST /api/subscribe (#12)") names this request: the same rule as report.ts subjectNames
function names(subject, method, path){
  var slash = path.indexOf("/"), pathname = slash >= 0 ? path.slice(slash) : path, s = String(subject || "").trim();
  if (s.toUpperCase().indexOf(String(method).toUpperCase() + " ") !== 0) return false;
  var rest = s.slice(method.length + 1), i = rest.indexOf(pathname);
  if (i < 0) return false;
  var after = rest.charAt(i + pathname.length);
  return after === "" || after === "?" || after === "#" || after === " " || after === "(";
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

/** /scan/about. `guard` is the guard pass's configuration in words (report.ts guardSetting, from the worker's vars). */
export function aboutPage(n: string, guard = "GenClass in guard mode with its default settings"): string {
  const st = visualStatus();
  const run = VISUAL_KINDS.length - NOT_RUN_HERE.size;
  const commit = VISUAL_BUILD.commit.slice(0, 7);
  const SOURCE_WORDS: Record<string, string> = { visual: "GenClass visual check", axe: "axe-core", audit: "Scanner audit", probe: "Race probe", judge: `Model judge (${JUDGE_NAME}), not measured` };
  const kinds = (Object.entries(KINDS) as [Kind, (typeof KINDS)[Kind]][])
    .map(([k, v]) => {
      const std = v.standard
        ? `<a href="${esc(v.standard.url)}">${esc(v.standard.label)}</a>`
        : k === "axe"
          ? "The WCAG success criteria in the rule's tags, or axe-core best practice"
          : v.source === "judge"
            ? `None: a model's judgement from a crop of the screenshot (<a href="#judge">the model judge</a>)`
            : "The measurement itself";
      const sev = k === "axe" ? "the rule's impact" : esc(v.severity);
      return `<tr><td>${esc(v.what)}<br><code class="kind">${esc(k === "axe" ? "axe:<rule id>" : k)}</code>${NOT_RUN_HERE.has(k as never) ? `<span class="notrun">Not run in the page check: it needs a visitor's clicks</span>` : ""}</td><td>${esc(CATEGORIES.find((c) => c.id === v.category)!.label)}<span class="notrun">${esc(SOURCE_WORDS[v.source])}</span></td><td>${sev}</td><td>${std}</td></tr>`;
    })
    .join("");
  const cats = CATEGORIES.map((c) => `<tr><td class="cat">${esc(c.label)}<small>${esc(c.covers)}</small></td><td class="r">${c.weight}</td></tr>`).join("");
  const sevRows = (SEVERITY_ORDER as Severity[])
    .map((s) => `<tr><td class="cat">${esc(s)}</td><td class="r">${SEVERITY_POINTS[s]}</td><td class="r">${rulePoints(s, 3).toFixed(1)}</td><td class="r">${rulePoints(s, 1000).toFixed(0)}</td></tr>`)
    .join("");
  // a worked example from the same functions the score uses
  const ex = [
    { rule: "axe:color-contrast", severity: "serious" as Severity, instances: 30, findings: 1, points: rulePoints("serious", 30) },
    { rule: "axe:image-alt", severity: "critical" as Severity, instances: 2, findings: 1, points: rulePoints("critical", 2) },
  ];
  const exValue = categoryValue(ex);
  const lcpGood = (LCP_GOOD_MS / 1000).toFixed(1);
  const lcpPoor = (LCP_POOR_MS / 1000).toFixed(0);
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
    parallel: ${VIEWS.map((v) => esc(v.label.toLowerCase())).join("; ")}. Each load has 16 seconds, then up to 4 more for the network to go quiet (half a second when the page had not finished loading).</li>
    <li>Runs the visual checks in each view for about 6 seconds: ${esc(st.checks)}, the runtime's visual chunk from
    commit <code>${esc(commit)}</code>, in an isolated part of the browser the page's scripts cannot reach. It presses
    Tab a few times on the desktop and scrolls with the mouse wheel, which some checks need (focus under a sticky header, a
    scroll lock, a control under a fixed bar). With GenClass on, the checks run in guard mode with their fixes turned on, and a
    second, report-only set of the same checks then measures the page again; the fixes are undone before the screenshot.
    The page's fetch and XHR requests in flight are counted and handed to the checks, which do not judge a blank page or a
    page that ignores clicks while a request runs.</li>
    <li>Takes a screenshot of the top of the page in each view and records the box of every finding.</li>
    <li>Asks a model, ${esc(JUDGE_NAME)} on ${esc(JUDGE_PLATFORM)}, about up to ${JUDGE_MAX_CALLS} single elements across the three views,
    from a crop of a viewport screenshot: the visual checks' findings, for a second look (with the element's measured facts),
    and elements the measured checks cannot judge (text over images, covered controls, buttons and links in the dark view).
    What it finds is labelled as judged by a model, never as measured (<a href="#judge">the model judge</a>, below).</li>
    <li>Runs axe-core ${esc(AXE_BUILD.version)} in each view, unmodified, in the same isolated part of the browser: its WCAG 2.2
    A and AA rules (tags ${AXE_TAGS.filter((t) => t !== "best-practice").map((t) => `<code>${esc(t)}</code>`).join(", ")}) and its best
    practices (<code>best-practice</code>). Only violations become findings; rules axe-core cannot decide by itself ("needs
    review") are counted and shown as a number, never scored. Three of its rules are turned off because the scanner measures
    the same thing itself and would otherwise count it twice: ${AXE_OFF.map((r) => `<code>${esc(r)}</code>`).join(", ")}. It does
    not look inside iframes and fetches nothing.</li>
    <li>Audits the light phone view: tap targets, the viewport meta tag and text sizes; then narrows the same page to 360 and
    320 px wide, without a reload, and measures whether it scrolls sideways. On the desktop and the light phone it compares each
    image's file with the size it is shown at.</li>
    <li>Reads what the browser itself reports (a DevTools protocol session of the scanner's own) while each view loads and its
    checks run: uncaught errors, <code>console.error</code>, the status and size of every response, and mixed content. On the
    desktop it reads Largest Contentful Paint and layout shifts once the network is quiet, before the scanner presses a key or
    scrolls.</li>
    <li>On the desktop page, with GenClass ${esc(RUNTIME_VERSION)} loaded in observe mode (telemetry off, model from
    <code>genclass.dev/model/</code>), types <code>a</code>, <code>ab</code>, <code>abc</code> into the first search box, 80 ms apart,
    and double-clicks the most prominent submit button of a same-origin form that would POST. Forms with a password or card
    field are skipped, and so are forms and buttons that would submit into another window. GET responses during the probe get 0 to 1,500 ms of extra latency, so they can arrive out of order.</li>
    <li>Opens the page once more with GenClass in guard mode and repeats the probe, to measure what guard changes.</li>
    <li>Scores the findings and keeps the report for 6 hours. The whole scan has a hard budget of ${Math.round(SCAN_BUDGET_MS / 1000)} seconds; a step that does not fit is skipped and the report says so. When the page sent
    requests other than GET while loading, findings that may come from the scanner's stand-in replies (template text, broken
    images, JavaScript errors, and GenClass diagnoses other than a duplicate) are listed but not scored.</li>
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
  <p class="intro">Six categories are each scored from 100 by their own findings, and the score is their weighted mean. Inside a
  category the findings are grouped by rule (one visual check, one axe-core rule, one audit). A rule takes points by its
  severity, a little more when it found many elements, and never more than ${INSTANCE_CAP} times its base, so a page with 200
  instances of one rule loses a bounded amount. Rules combine by multiplication, so each further rule takes a share of what is
  left and a category never goes below 0. A category this scan did not measure (axe-core did not finish, the race probe found
  nothing to try) is left out of the mean and shown as not measured, never as 100. The same findings always give the same score.</p>
  <div class="formula">points(rule) = base(severity) &times; min(${INSTANCE_CAP}, 1 + log<sub>10</sub>(instances))<br>
  category = 100 &times; &Pi;<sub>rules</sub> (1 &minus; points(rule) / 100)<br>
  score = &Sigma; weight &times; category / &Sigma; weight, over the categories measured on this scan<br>
  base: ${(SEVERITY_ORDER as Severity[]).map((s) => `${s} ${SEVERITY_POINTS[s]}`).join(", ")} &middot; ${esc(weightsWords())}</div>
  <p class="intro">For example, 30 elements failing axe-core's <code>color-contrast</code> (serious) take ${ex[0].points.toFixed(1)} points and 2
  images failing <code>image-alt</code> (critical) take ${ex[1].points.toFixed(2)}, so accessibility is 100 &times;
  (1 &minus; ${(ex[0].points / 100).toFixed(2)}) &times; (1 &minus; ${(ex[1].points / 100).toFixed(4)}) = ${exValue.toFixed(1)}, shown as
  ${Math.round(exValue)}. With every other category at 100 the score is ${Math.round((exValue * 25 + 75 * 100) / 100)}.</p>
  <div class="two">
    <div><table class="dt"><thead><tr><th>Category</th><th class="r">Weight</th></tr></thead><tbody>${cats}</tbody></table>
    <figcaption>Table 1. The six categories, what each covers and its weight in the score.</figcaption>
    <table class="dt mt"><thead><tr><th>Severity</th><th class="r">Base</th><th class="r">3 instances</th><th class="r">10 or more</th></tr></thead><tbody>${sevRows}</tbody></table>
    <figcaption>Table 2. The points one rule takes from its category, by severity and instances.</figcaption></div>
    <div><table class="dt"><thead><tr><th>Finding</th><th>Category</th><th>Severity</th><th>Standard</th></tr></thead><tbody>${kinds}</tbody></table>
    <figcaption>Table 3. Every kind of finding, its category, default severity and the standard it is judged by. The same
    element with the same problem in two views counts once; an axe-core rule or an audit counts the most elements it found in
    any one view.</figcaption></div>
  </div>
  <div class="prose">
  <h3 class="h3" id="severity">Where severities come from</h3>
  <ul>
    <li>The visual checks measure their own severity (high, medium, low), read as serious, moderate and minor. A blank page, a
    page that ignores clicks and a page that cannot scroll are critical.</li>
    <li>axe-core rules keep axe-core's impact (critical, serious, moderate, minor). A rule that is only a best practice, with no
    WCAG A or AA tag, is one level lower, since it is advice rather than a requirement.</li>
    <li>The scanner's audits set theirs from the thresholds below.</li>
    <li>A finding the model judge made is always moderate: it is a judgement, not a measured severity.</li>
  </ul>
  <h3 class="h3" id="audits">The audits and their thresholds</h3>
  <ul>
    <li><b>Tap targets</b> (light phone, <a href="https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html">WCAG 2.2 SC 2.5.8</a>, serious):
    a visible link, button, form control or element with a control role smaller than ${TARGET_MIN} by ${TARGET_MIN} CSS px, when a
    ${TARGET_MIN} px circle on its centre touches another target or another small target's circle. Links inside a sentence,
    checkboxes and radios at the browser's own size or with a label of at least ${TARGET_MIN} by ${TARGET_MIN} px, disabled
    controls, and targets hidden, clipped or off the page are left out.</li>
    <li><b>Zoom</b> (<a href="https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html">WCAG 2.2 SC 1.4.4</a>, serious): the
    viewport meta tag has <code>user-scalable=no</code> or <code>maximum-scale</code> below 2.</li>
    <li><b>Viewport meta tag</b> (Lighthouse's viewport audit, serious): none on the page, so a phone lays it out 980 px wide.</li>
    <li><b>Text size</b> (light phone, Lighthouse's legible font size, ${FONT_MIN} px): a block of at least 40 characters of text
    under ${FONT_MIN} px is minor; more than 40% of the page's text under ${FONT_MIN} px (Lighthouse's audit fails) is moderate.</li>
    <li><b>Reflow</b> (<a href="https://www.w3.org/WAI/WCAG22/Understanding/reflow.html">WCAG 2.2 SC 1.4.10</a>): the light phone
    narrowed to 360 and 320 px; the page is wider than the viewport and can scroll sideways. Serious at 360 px, moderate at 320
    px only, minor when only tables or preformatted text stick out. Not judged when it already scrolls sideways at 390 px.</li>
    <li><b>Oversized images</b> (Lighthouse's "Properly size images", minor; moderate above 1 MB in all): more than
    ${OVERSIZE_RATIO} times the pixels the image covers on a ${JUDGE_DPR.desktop}x screen (desktop) or ${JUDGE_DPR.phone}x screen
    (phone), and more than ${Math.round(OVERSIZE_BYTES / 1024)} KB transferred. SVG is left out.</li>
    <li><b>Images without dimensions</b> (web.dev, minor): no width and height and no
    aspect-ratio (as attributes or inline style), arriving after the first paint, and a layout shift from 50 ms before to 500 ms
    after it arrived moved content below it down. An unsized
    image that moved nothing is not reported.</li>
    <li><b>Largest Contentful Paint</b> (<a href="https://web.dev/articles/lcp">web.dev</a>), judged on the faster of two loads in the
    same browser, the desktop view and the light phone (which loads without GenClass): minor when that is above ${lcpGood} s
    (needs improvement), moderate above ${lcpPoor} s (poor). One load can be much slower than a visitor's: in calibration a text
    heading a desktop browser painted at 0.59 s took 2.64 s in the scanner's desktop view and 2.13 s on its phone.</li>
    <li><b>JavaScript errors</b> (Lighthouse's console errors audit): uncaught errors and unhandled rejections in the page's own
    main frame while it loads, moderate (minor when every one came from a script on another site); <code>console.error</code>,
    minor. Errors from the scanner's own code are left out.</li>
    <li><b>Failed requests</b> (<a href="https://www.rfc-editor.org/rfc/rfc9110#section-15.5">RFC 9110</a>): same-site scripts,
    data requests, frames and other files answered with 4xx or 5xx. A script that answers 404, 410 or 5xx is serious, any other 5xx
    or a frame moderate, the rest minor. Images, stylesheets, fonts and media belong to the visual checks; 401, 403, 407 and 429
    depend on who is asking and are counted, not scored; <code>/favicon.ico</code> is the browser's own request.</li>
    <li><b>Mixed content</b> (<a href="https://www.w3.org/TR/mixed-content/">W3C Mixed Content</a>): on an https page, a request the
    browser blocked for being http is serious; a file referenced over http that the browser upgraded or allowed is minor.</li>
    <li><b>JavaScript transferred</b>: more than ${(JS_NOTE_BYTES / 1_000_000).toFixed(0)} MB compressed on the desktop (the
    scanner's own GenClass runtime left out) is listed as a note and not scored.</li>
  </ul>
  <p>Timings are measured once, in Cloudflare's browser in a data center: a fast network, three views loading at the same time in
  one browser, and GenClass loading in the desktop view for the race probe. They are indicative; field data such as Chrome's
  CrUX report is the reference for what visitors see.</p>
  <h3 class="h3" id="once">Counted once</h3>
  <ul>
    <li>Text the visual checks found below 1.5:1 is a visual bug; axe-core's <code>color-contrast</code> leaves out that same
    element in that view.</li>
    <li>axe-core's <code>color-contrast</code> leaves out the text WCAG 1.4.3 exempts that a page can show machine-readably:
    text inside an element marked <code>role="img"</code> or <code>aria-hidden="true"</code> (part of a picture, or decoration), and
    text that is only the site's own name (a logotype). The text-size audit leaves out the first kind too.</li>
    <li>A layout shift the visual checks reported stands for the Cumulative Layout Shift note.</li>
    <li>Sideways scrolling at 390 px stands for the 360 and 320 px reflow check.</li>
  </ul>
  <h3 class="h3" id="unscored">Listed, not scored</h3>
  <ul>
    <li>Findings that may come from the scanner's stand-in answers to the page's POST requests, or from files it refused to load
    (template text, broken images, a blank main region, JavaScript errors, GenClass diagnoses other than a duplicate), when every
    view they appeared in had such answers or refusals.</li>
    <li>Findings in a category this scan did not measure, and the JavaScript size note.</li>
    <li>Visual findings a model (${esc(JUDGE_NAME)}) judged as probably fine from a crop of the screenshot, in every view they
    appeared in: they are listed on their own, under "Listed, not scored (a model judged it as probably fine)", with the crop
    and the measurement as it was made (<a href="#judge">the model judge</a>).</li>
    <li>Layout shift: Cumulative Layout Shift on the desktop while the page loads (<a href="https://web.dev/articles/cls">web.dev</a>,
    session windows with gaps of at most 1 s and 5 s at most; above ${CLS_GOOD} needs improvement, above ${CLS_POOR} poor) and the
    visual checks' layout shift above 0.25. Both are listed with what was measured and not scored. In the scanner's browser every
    request waits for the scanner's own checks before it continues, so content that scripts add after the first paint moves the
    page more than it does for most visitors: on the three public pages in the calibration where the scanner measured a shift, a
    desktop browser loading the same page measured none.</li>
  </ul>
  <h3 class="h3" id="axe">axe-core</h3>
  <p>axe-core ${esc(AXE_BUILD.version)} is Copyright (c) 2015 to 2026 Deque Systems, Inc. and licensed under the
  <a href="https://www.mozilla.org/en-US/MPL/2.0/">Mozilla Public License 2.0</a>. The scanner runs it unmodified; its source code
  is at <a href="https://github.com/dequelabs/axe-core">github.com/dequelabs/axe-core</a>. axe-core's own guide for each rule is
  linked from the finding.</p>
  <h3 class="h3" id="visual">The visual checks</h3>
  <p>The checks are the measured visual checks built for the GenClass runtime (${esc(st.short)}), 23 kinds with fixed
  thresholds (Table 2), ${run} of which run in the page check (<code>click-blocked</code> needs a visitor's clicks, and the
  scanner clicks only the race probe's button): text under 1.5:1
  contrast on a background it can measure (text over images, gradients or video is skipped), <code>[object Object]</code>,
  <code>$NaN</code> or raw <code>{{ }}</code> placeholders in visible text, lorem ipsum, garbled characters, images, background
  images, video, stylesheets, fonts and icon fonts that failed, files the Content-Security-Policy blocked, CSS variables defined
  nowhere, stretched images, sideways scrolling, a missing viewport meta tag on phones, layout shifts above 0.25, an empty main
  region, a page that ignores clicks or cannot scroll, controls under fixed bars, focus hidden under sticky bars, and dialogs that
  are covered. Each finding says what was measured and against which threshold.</p>
  <p>How often the checks are right, as measured for the runtime on GitHub runners (Chromium 153, 2026-10-13): on its
  fixture pages, 35 of 35 planted faults found across the 23 kinds; on its bench, no false reports in 128 page views of
  clean local apps, and recall 1.00 on planted faults in real app layouts for 19 of the 23 kinds (bench run 5); on public
  home pages (bench run 4: 31 of 40 sites measured, 96 loads), 8 findings, 5 confirmed real, 0 check errors, 3
  unconfirmed. The scanner embeds the same checks at a later commit (<code>${esc(commit)}</code>) and runs them in
  Cloudflare's browser (Chrome 128 when last measured) for about 6 s per view, with 4 Tab presses and no hover, so these
  numbers describe the checks, not this scanner. Details are in the runtime's RESULTS.md, sections 8 and 9.</p>
  <h3 class="h3">The with-GenClass score</h3>
  <p>It is measured, never projected${st.shipped ? "" : `, and its visual half uses code that is not released yet: the visual
  fixes are in testing for a release after runtime ${esc(RUNTIME_VERSION)}, and runtime ${esc(RUNTIME_VERSION)}, which the install
  line on the page check loads, does not have them`}. In the same browser, the visual checks run in guard mode with their
  fixes on, as the ${st.shipped ? "" : "coming "}option <code>GenClass.init({ mode: "guard", visual: { on: true, fix: true } })</code>
  runs them, and a second set of the same checks, report-only, measures the page again with the fixes in place. The visual
  fixes change three kinds in the page: text colour for invisible text, a leaked inline <code>pointer-events: none</code> and a
  leaked inline scroll lock on html or body. A finding counts as fixed only when the fix was applied and the re-check no
  longer found it, in every view where it appeared; for a leaked <code>pointer-events: none</code> or scroll lock the re-check
  must also have run long enough (about 4.5 s) to see it again. Every other kind is reported for the developer with the
  suggested CSS or code, and the report says so on each finding. The with-GenClass score only subtracts verified fixes: a
  problem that shows up only once a fix is in place (text that becomes measurable after a leaked
  <code>pointer-events: none</code> is removed, for example) is not added to it, and the report says how many there were.</p>
  <p>The race probe runs again in a fresh page with ${esc(guard)}; a double submit counts as fixed only when guard's own
  action sent fewer requests, and a late response only when guard's own recorded discard or defer was on that same request.
  When guard flags a problem but its expected gain does not clear the safety margin, the report says it held back.</p>
  </div>
</section>
${judgeSection()}
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
    <li>For the model judge, crops of the screenshots (an element and 24 px around it) and the element's measured facts are sent
    to ${esc(JUDGE_PLATFORM)}, inside Cloudflare's network, with no account or visitor data. Cloudflare's
    <a href="${esc(WORKERS_AI_DATA_URL)}">Workers AI data-usage page</a> says it does not use what is sent to train models, and stores it
    only when the account adds a storage service to it; this scanner does not. The crops a report shows are kept with its
    screenshots and deleted with them.</li>
    <li>The visitor's IP address is used only for the per-minute rate limit, as a hash, and is not stored.</li>
    <li>The browser starts empty for every scan and is closed afterwards. No cookies or storage carry over between scans.</li>
  </ul>
</section>
<footer class="dfoot">The page check is part of <a href="https://genclass.dev/">GenClass</a>, an open-source runtime for web apps
(<a href="https://github.com/genclass-dev/GenClass-lib">source</a>). Questions: <a href="mailto:${OPT_OUT_EMAIL}">${OPT_OUT_EMAIL}</a>.</footer>`;
  return shell(n, "How the page check works | GenClass", "about", body, "");
}

/** Cloudflare's statement of what Workers AI does with what it is sent (read 2026-10-14). */
export const WORKERS_AI_DATA_URL = "https://developers.cloudflare.com/workers-ai/platform/data-usage/";

/** /scan/about#judge: which findings come from the model, how it was measured, what it is sent, what it costs. */
export function judgeSection(): string {
  const e = JUDGE_EVAL;
  const share = Object.values(JUDGE_SHARE);
  const tokens = 1300;
  return `<section class="blk prose" id="judge">
  <div class="blk-h"><h2>The model judge (${esc(JUDGE_NAME)})</h2><span class="aside">judged, not measured</span></div>
  <p>Every other finding comes from a measured check: a number against a threshold the finding names. The page check also asks a
  model, <b>${esc(JUDGE_NAME)}</b> (<code>${esc(JUDGE_MODEL)}</code>, Cloudflare's open decision model, which reads images), running on
  <b>${esc(JUDGE_PLATFORM)}</b>, about single elements. It is always given a crop of a viewport screenshot (the element's box and
  ${CROP_PAD} px around it), where the element is in it, and the view. It answers whether a visitor can see and use the element as
  intended, and if not, what kind of problem it is; its score is 1 minus its probability that nothing is wrong.</p>
  <ul>
    <li><b>A second look at measured findings.</b> For a visual check's finding the model is also given the element's measured
    facts in words (its box, colours and contrast, what is behind it, what the hit test found on top of it, how much of it is
    clipped; text lengths, never the text), with the instruction to judge by what the screenshot shows and to treat the facts as
    hints: the evaluation's <code>clef-img-p3</code> prompt. Sideways scrolling, images that failed to load and template text stay
    as measured, as the evaluation recommends (at its threshold the model dropped 13 of 34 real sideways-scrolling findings, which a
    crop cannot show, and 4 of 15 real broken images; template text was already real 5 times in 6), and so do findings with no
    element to crop (a failed stylesheet or font, a missing viewport tag, a lock on the whole page) and layout shift (already listed,
    not scored). A finding the model scores below ${KEEP_THRESHOLD} in every view it appeared in moves to "Listed, not scored (a model
    judged it as probably fine)", with the crop; it is never dropped. On the evaluation, the rules followed by the model at that
    threshold had precision ${e.keep.precision.toFixed(2)} where the rules alone had ${e.keep.rulesPrecision}, and found
    ${e.keep.recall.toFixed(2)} of the real problems where the rules alone found ${e.keep.rulesRecall.toFixed(2)}.</li>
    <li><b>Findings of its own, where the measured checks abstain:</b> controls another element covers or that are partly clipped,
    every visible button and link in the dark view, and text over images, gradients or backgrounds the checks cannot know, in
    that order and the first screen of the page first, leaving out the site's own name (a logotype). Here the model gets the crop,
    the view and the tag only (the evaluation's <code>${esc(e.find.variant)}</code> prompt): the facts of such an element are the
    measurements the checks could not make, and in calibration they talked the model out of the fixture's deliberate bugs. An
    element it scores at ${FIND_THRESHOLD} or more becomes a Visual bugs finding, moderate, labelled "${esc(JUDGE_LABEL)}", with the
    crop and what it answered. That threshold was the lowest with precision at least 0.8 on the part of the evaluation used to
    choose it (${e.find.devReal} of ${e.find.devFlagged}); on the rest, ${e.find.real} of the ${e.find.flagged} crops it scored that high
    were real problems (precision ${e.find.precision.toFixed(2)}), ${e.find.noRuleReal} of ${e.find.noRuleFlagged} among the crops no rule
    had flagged. Few public pages give it anything to find: <a href="https://github.com/genclass-dev/GenClass-lib/blob/main/scan-worker/CALIBRATION.md">the
    calibration</a> counts what it found and whether it was right.</li>
    <li><b>How it was measured</b> (<code>${esc(e.ref)}</code>): ${e.crops.toLocaleString("en-US")} crops of elements on public
    pages, ${e.real} of them real problems, labelled by ${esc(e.labellers)} (${e.doubleLabelled} crops labelled by two agents agreed with
    Cohen's kappa ${e.kappa}). Split by site: ${e.dev.crops} crops (${e.dev.real} real) to choose the prompt and thresholds,
    ${e.report.crops.toLocaleString("en-US")} (${e.report.real} real) to measure them once. The labels come from models too, so these
    numbers say how often ${esc(JUDGE_NAME)} agreed with the labelling agents, on crops cut the way the page check cuts them.</li>
    <li><b>Bounds.</b> At most ${JUDGE_MAX_CALLS} elements per scan (at least ${share.join(", ")} for the desktop, light phone and
    dark phone views, and a view may use what the views before it left), each asked as soon as its crop is taken and answered while the rest of the scan runs; an
    answer counts only if it comes within
    ${JUDGE_TIMEOUT_MS / 1000} seconds. When ${esc(JUDGE_PLATFORM)} does not answer, or answers late, the findings stay as measured.
    About ${tokens.toLocaleString("en-US")} input tokens per element or fewer at $${e.usdPerMillionInput} per million (Workers AI
    pricing, ${esc(e.pricingDate)}): at most about $${((tokens * JUDGE_MAX_CALLS * e.usdPerMillionInput) / 1e6).toFixed(4)} for ${JUDGE_MAX_CALLS} elements.</li>
    <li><b>What is sent.</b> The crop and the words above go to ${esc(JUDGE_PLATFORM)}, inside Cloudflare's network, with no
    account or visitor data. Cloudflare's <a href="${esc(WORKERS_AI_DATA_URL)}">Workers AI data-usage page</a> says it does not use
    what is sent to train models, and stores it only when the account adds a storage service; this scanner does not. The crops a
    report shows are kept with its screenshots and deleted with them after 24 hours.</li>
  </ul>
</section>`;
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
