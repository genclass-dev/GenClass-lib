// The Supabase Studio frame every signed-in page and every app dashboard uses (the owner asked for Supabase's layout
// one to one, 2026-10-25): a 48px header (the organization and project switchers with their slash dividers, the
// Connect button, Feedback, a search pill that opens the command menu, help and the account menu), a 48px icon rail
// that widens to 208px with its labels on hover or focus, an optional product menu for views with sub-pages, and the
// page on the canvas. The organization is the account and a project is an app (one key each).
// Tokens are Supabase Studio's dark theme (canvas #121212, surfaces #171717 / #1f1f1f, borders #2e2e2e, text #fafafa,
// #b4b4b4 and #898989, brand #3ecf8e, primary buttons #006239 with a 30% brand border, Inter for text and Source Code
// Pro for code, 6px corners), under the token names the dashboard's own CSS already uses (--paper is the canvas, --ink
// the text). Two deviations, for contrast the tests measure: input borders are #636363 (3:1 on the canvas; Supabase's
// #393939 is about 1.6:1) and the muted text #898989 stays at 4.5:1 or more on every surface.
// Dark only, like every genclass.dev page: `color-scheme: dark`, no prefers-color-scheme rules. No external scripts;
// fonts from Google Fonts only; no style attributes (the CSP allows styles by nonce only). Server-rendered text goes
// through esc(); the frame's script inserts text with textContent and never throws into the page (every lookup is
// null-checked, so the page scripts run the same in tests that render only <main>).
// Imports only escape.ts, so pages.ts, account-pages.ts and billing-pages.ts can all use it without an import cycle.

import { esc } from "./escape.js";

// --------------------------------------------------------------------------------------------- icons

/** Lucide's paths (ISC licence), drawn at stroke 1.5 as Studio draws them. */
const PATHS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  list: '<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>',
  pointer:
    '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.04 9.69a.5.5 0 0 1 .65-.65l11 4.5a.5.5 0 0 1-.07.95l-4.35 1.04a1 1 0 0 0-.74.74l-1.04 4.35a.5.5 0 0 1-.95.07z"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/>',
  loop: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  blocks: '<rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  chevrons: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  sparkles:
    '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** An inline icon (decorative: aria-hidden). */
export function icon(name: IconName, size = 16): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}

/** Supabase's header divider: a thin forward slash in the strongest border colour. */
const DIVIDER =
  '<span class="sb-div" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><path d="M16 3.5 7.5 20.5"/></svg></span>';

/** genclass.dev's mark, where Studio puts its own logo (the home link of the header). */
const MARK = '<img src="https://genclass.dev/brand/mark-64.png?v=2" alt="" width="22" height="22">';

/** The site's own icons (site/public/brand, apple-touch-icon.png), so every genclass.dev page shows the same one. */
export const ICON_LINKS =
  '<link rel="icon" href="https://genclass.dev/brand/mark-32.png?v=2" sizes="32x32" type="image/png">' +
  '<link rel="icon" href="https://genclass.dev/brand/mark-64.png?v=2" sizes="64x64" type="image/png">' +
  '<link rel="apple-touch-icon" href="https://genclass.dev/apple-touch-icon.png">';

/** A Supabase badge (rounded, mono, upper case): default, brand (green), warning (amber) or destructive. */
export function badge(text: string, kind: "default" | "brand" | "warning" | "destructive" = "default", id?: string): string {
  return `<span class="bdg${kind === "default" ? "" : ` ${kind}`}"${id ? ` id="${esc(id)}"` : ""}>${esc(text)}</span>`;
}

// --------------------------------------------------------------------------------------------- styles

/**
 * Studio's dark tokens under the dashboard's token names, the base elements, and the frame. Pages add their own CSS
 * after it (DASH_CSS, ORG_CSS, the billing CSS) and may use every token here.
 */
export const STUDIO_CSS = `
:root{
  --paper:#121212;--panel:#1f1f1f;--ink:#fafafa;--ink2:#b4b4b4;--ink3:#898989;--rule:#2e2e2e;--rule2:#363636;--line:#636363;
  --accent:#3ecf8e;--accent-x:#3ecf8e;--accent-f:#006239;--accent-t:#0b2118;--warn:#f9785b;--warn-f:#e54d2e;--warn-t:#2a1410;
  --bar:#898989;--bar2:#3ecf8e;--bar3:#e54d2e;--ink-h:#ffffff;--green-h:#007a4a;--on-green:#fafafa;--head:#121212;
  --code:#171717;--codeink:#fafafa;
  --s75:#171717;--s200:#242424;--s300:#2e2e2e;--ctl:#1a1a1a;--rule3:#454545;--brand-b:rgba(62,207,142,.3);--amber:#f1a10d;--amber-t:#2b1d05;--ovl:#1c1c1c;
  --display:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"Source Code Pro",ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme:dark;
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--paper)}
body{background:var(--paper);color:var(--ink);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:"cv11","ss01"}
::selection{background:#3ecf8e40;color:var(--ink)}
a{color:inherit;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
h1,h2,h3{font-family:var(--display);font-weight:400;letter-spacing:-.01em;text-wrap:balance}
h1{font-size:24px;line-height:1.25}
h2{font-size:16px;line-height:1.4}
h3{font-size:14px;line-height:1.4}
code,pre,.mono{font-family:var(--mono)}
.muted{color:var(--ink3)}
.small{font-size:13px}
.hidden{display:none!important}
.vh{display:none!important}
.skip{position:absolute;left:12px;top:-60px;z-index:90;background:var(--accent-f);color:var(--on-green);padding:8px 12px;border-radius:6px;font-size:13px;text-decoration:none}
.skip:focus{top:8px}
[tabindex="-1"]:focus{outline:none}
.sb [id]{scroll-margin-top:64px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.stack>*+*{margin-top:12px}
.mt-xl{margin-top:40px}.mt-l{margin-top:24px}.mt-s{margin-top:12px}.big{font-size:16px}.brk{word-break:break-all}.minw0{min-width:0}
.ic{display:block;flex:none}
/* buttons: Studio's primary (dark green, green border), default (grey) and outline; tiny 26px, small 32px */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 12px;border-radius:6px;font:400 13px/1 var(--sans);cursor:pointer;border:1px solid var(--brand-b);background:var(--accent-f);color:var(--on-green);text-decoration:none;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.btn:hover{background:var(--green-h);border-color:#3ecf8e99}
.btn:disabled{opacity:.55;cursor:progress}
.btn.green{background:var(--accent-f);border-color:var(--brand-b);color:var(--on-green)}
.btn.green:hover{background:var(--green-h);border-color:#3ecf8e99}
.btn.ghost,.btn.paper{background:var(--s200);color:var(--ink);border-color:#393939}
.btn.ghost:hover,.btn.paper:hover{background:var(--s300);border-color:#4d4d4d}
.btn.text{background:transparent;border-color:transparent;color:var(--ink2)}
.btn.text:hover{background:var(--s200);color:var(--ink)}
.btn.danger{background:#3c1712;border-color:#7f2c20;color:var(--ink)}
.btn.danger:hover{background:#52201a;border-color:#b23b28}
.btn.sm,.btn.tiny{min-height:26px;padding:0 10px;font-size:12px}
.btn.xl{min-height:40px;padding:0 18px;font-size:14px}
.btn .ic{width:14px;height:14px}
.btn.ico{padding:0;width:26px;min-height:26px}
@media (pointer:coarse){.btn,.btn.sm,.btn.tiny{min-height:40px}.btn.ico{width:40px}}
button.lnk{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer}
/* inputs: Studio's control fill and 6px corners; the border at 3:1 for contrast */
input[type=text],input[type=email],input[type=password],input[type=url],input[type=date],input[type=search],select,textarea{min-height:34px;width:100%;padding:0 12px;border-radius:6px;border:1px solid var(--line);background:var(--ctl);color:var(--ink);font:14px var(--sans)}
textarea{padding:8px 12px;min-height:80px;resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
input:disabled,select:disabled{opacity:.6}
::placeholder{color:#6b6b6b;opacity:1}
label{font-size:13px;color:var(--ink2)}
/* tables: Studio's grid look, header row on the sidebar tone */
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--rule);white-space:nowrap}
th{color:var(--ink3);font:400 12px var(--sans);background:var(--s75)}
.tablewrap{overflow-x:auto}
pre.code{background:var(--code);color:var(--codeink);border:1px solid var(--rule);border-radius:6px;padding:12px 14px;font:13px/1.6 var(--mono);overflow-x:auto;white-space:pre}
.note{border:1px solid #5c3d06;background:var(--amber-t);padding:10px 14px;border-radius:6px;font-size:13px;color:var(--ink)}
.note.ok,.ok{border-color:#0f5a37;background:var(--accent-t)}
/* badges */
.bdg{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;border:1px solid var(--rule2);background:var(--s75);color:var(--ink2);font:500 10.5px/1 var(--mono);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
.bdg.brand{border-color:#0f5a37;background:var(--accent-t);color:var(--accent)}
.bdg.warning{border-color:#5c3d06;background:var(--amber-t);color:var(--amber)}
.bdg.destructive{border-color:#5c2018;background:var(--warn-t);color:var(--warn)}
.bdg i{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}

/* ---------- the frame */
body.sb{min-height:100vh}
.sb-top{position:sticky;top:0;z-index:40;display:flex;align-items:center;height:48px;border-bottom:1px solid var(--rule);background:var(--head);padding-right:12px;gap:4px}
.sb-home{display:flex;align-items:center;justify-content:center;width:48px;height:48px;flex:none}
.sb-home img{width:22px;height:22px;display:block}
.sb-ib.sb-burger{display:none}
.sb-crumbs{display:flex;align-items:center;min-width:0;flex:0 1 auto;font-size:14px}
.sb-div{color:var(--rule3);display:flex;flex:none}
.sb-cr{display:flex;align-items:center;gap:6px;min-width:0;padding:0 4px;height:28px;border-radius:6px;color:var(--ink);text-decoration:none;background:none;border:0;font:inherit;cursor:pointer;white-space:nowrap}
.sb-cr:hover,.sb-cr[aria-expanded=true]{background:var(--s200)}
.sb-cr .nm{overflow:hidden;text-overflow:ellipsis;max-width:240px}
.sb-cr .ic{color:var(--ink3)}
.sb-cr.static{cursor:default}.sb-cr.static:hover{background:none}
.sb-acts{display:flex;align-items:center;gap:8px;margin-left:12px;flex:none}
.sb-right{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none}
.sb-search{display:inline-flex;align-items:center;gap:8px;height:26px;padding:0 6px 0 10px;min-width:150px;border-radius:999px;border:1px solid #393939;background:var(--s75);color:var(--ink3);font:12px var(--sans);cursor:pointer}
.sb-search:hover{border-color:#4d4d4d;color:var(--ink2)}
.sb-search kbd{margin-left:auto;font:11px var(--mono);color:var(--ink3);padding:0 4px}
.sb-ib{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:999px;border:1px solid #393939;background:var(--s75);color:var(--ink2);cursor:pointer;text-decoration:none}
.sb-ib:hover{color:var(--ink);border-color:#4d4d4d}
.sb-av{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:999px;background:#2b4a3c;color:var(--ink);font:500 12px var(--sans);border:1px solid #3a5a4b;cursor:pointer;text-transform:uppercase}
/* dropdowns (organization, project, help, account) */
.dd{position:relative;display:flex;align-items:center;min-width:0}
.dd-m{position:absolute;top:calc(100% + 6px);left:0;z-index:70;min-width:240px;max-width:min(340px,90vw);max-height:70vh;overflow:auto;background:var(--ovl);border:1px solid #333;border-radius:6px;padding:4px;box-shadow:0 12px 32px rgba(0,0,0,.5)}
.dd-m.end{left:auto;right:0}
.dd-m[hidden]{display:none}
.dd-m .dd-l{display:block;padding:6px 8px 4px;font:12px var(--sans);color:var(--ink3)}
.dd-m a,.dd-m button{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border-radius:4px;font:13px var(--sans);color:var(--ink2);text-decoration:none;background:none;border:0;cursor:pointer;text-align:left}
.dd-m a:hover,.dd-m button:hover,.dd-m a:focus-visible,.dd-m button:focus-visible{background:var(--s300);color:var(--ink);outline:none}
.dd-m a[aria-current] {color:var(--ink)}
.dd-m a[aria-current]::after{content:"";margin-left:auto;width:14px;height:14px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/14px no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/14px no-repeat}
.dd-m hr{border:0;border-top:1px solid #333;margin:4px -4px}
.dd-m .who{padding:8px 8px 6px;font-size:13px;color:var(--ink);overflow-wrap:anywhere}
.dd-m .who small{display:block;color:var(--ink3);font-size:12px}
.dd-m form{display:block}
.sb-body{display:flex;min-height:calc(100vh - 48px)}
/* the rail: 48px of icons; its labels show while the pointer or the focus is on it (Studio's "expand on hover") */
.sb-rail{position:sticky;top:48px;align-self:flex-start;height:calc(100vh - 48px);width:48px;flex:none;z-index:30}
.sb-rail nav{position:absolute;inset:0 auto 0 0;width:48px;height:100%;display:flex;flex-direction:column;gap:2px;padding:8px;background:var(--head);border-right:1px solid var(--rule);overflow:hidden;transition:width .15s ease,box-shadow .15s ease}
.sb-rail:hover nav,.sb-rail:has(:focus-visible) nav{width:208px;box-shadow:12px 0 24px rgba(0,0,0,.35)}
.sb-rail a{display:flex;align-items:center;gap:10px;height:32px;min-height:32px;padding:0 6px;border-radius:6px;color:var(--ink3);text-decoration:none;font-size:14px;white-space:nowrap}
.sb-rail a .ic{width:20px;height:20px}
.sb-rail a:hover{background:var(--s200);color:var(--ink)}
.sb-rail a[aria-current=true],.sb-rail a[aria-current=page]{background:var(--s300);color:var(--ink)}
.sb-rail a .lbl{opacity:0;transition:opacity .1s}
.sb-rail a .cnt{margin-left:auto;font:11px var(--mono);color:var(--ink3);opacity:0}
.sb-rail:hover a .lbl,.sb-rail:has(:focus-visible) a .lbl,.sb-rail:hover a .cnt,.sb-rail:has(:focus-visible) a .cnt{opacity:1}
.sb-rail hr{border:0;border-top:1px solid var(--rule);margin:6px 2px}
.sb-rail .end{margin-top:auto}
/* the product menu: Studio's second column, its title on top, groups under small labels */
.sb-menu{position:sticky;top:48px;align-self:flex-start;height:calc(100vh - 48px);width:240px;flex:none;border-right:1px solid var(--rule);background:var(--head);overflow-y:auto}
.sb-menu:not(:has(.sb-pm:not(.vh))){display:none}
.sb-pm .t{display:flex;align-items:center;height:48px;padding:0 20px;border-bottom:1px solid var(--rule);font-size:16px;color:var(--ink)}
.sb-pm .g{padding:14px 12px 6px}
.sb-pm .g+.g{border-top:1px solid var(--rule)}
.sb-pm .gl{display:block;padding:0 8px 6px;font:12px var(--sans);color:var(--ink3)}
.sb-pm a{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:6px;font-size:13.5px;color:var(--ink2);text-decoration:none}
.sb-pm a:hover{background:var(--s200);color:var(--ink)}
.sb-pm a[aria-current=true],.sb-pm a[aria-current=page]{background:var(--s300);color:var(--ink)}
.sb-pm a .ic{width:14px;height:14px;color:var(--ink3)}
/* the page */
main.wrap{flex:1;min-width:0}
.sb-page{max-width:1200px;margin:0 auto;padding:32px 40px 64px}
.sb-page.wide{max-width:1600px}
.sb-ph{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:flex-end;justify-content:space-between;margin-bottom:24px}
.sb-ph h1{font-size:24px}
.sb-ph p{color:var(--ink3);font-size:14px;margin-top:4px;max-width:72ch}
.sb-ph .acts{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pnl{background:var(--panel);border:1px solid var(--rule);border-radius:6px;min-width:0}
.pnl-h{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--rule);min-height:48px}
.pnl-h h2,.pnl-h h3{font-size:14px;color:var(--ink)}
.pnl-h .aside{font-size:12px;color:var(--ink3)}
.pnl-b{padding:20px}
.pnl-f{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;align-items:center;padding:12px 20px;border-top:1px solid var(--rule)}
.hs{font-size:18px;color:var(--ink);margin:40px 0 16px}
/* the modal (Connect, the command menu): an overlay once the script runs; without it, an ordinary section */
.sb-modal{margin-top:24px}
.js .sb-modal{display:none;margin:0}
.js .sb-modal.open{display:flex;position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.66);align-items:flex-start;justify-content:center;padding:7vh 16px 16px;overflow:auto}
.sb-mbox{width:100%;max-width:860px;background:var(--paper);border:1px solid #333;border-radius:8px;box-shadow:0 24px 64px rgba(0,0,0,.6);min-width:0}
.sb-mh{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--rule)}
.sb-mh h2{font-size:16px}
.sb-mh p{font-size:13px;color:var(--ink3);margin-top:2px}
.sb-x{display:none}
.js .sb-x{display:inline-flex;background:none;border:0;color:var(--ink3);cursor:pointer;padding:2px;border-radius:4px}
.sb-x:hover{color:var(--ink)}
.sb-mb{padding:16px 20px 20px}
/* tabs: Studio's underlined tabs */
.sb-tabs{display:flex;gap:20px;border-bottom:1px solid var(--rule);overflow-x:auto;scrollbar-width:none}
.sb-tabs button{background:none;border:0;border-bottom:1px solid transparent;margin-bottom:-1px;padding:10px 0;font:14px var(--sans);color:var(--ink3);cursor:pointer;white-space:nowrap;display:inline-flex;gap:6px;align-items:center}
.sb-tabs button:hover{color:var(--ink2)}
.sb-tabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--ink)}
.js .tabp:not(.on){display:none}
.tabp{padding-top:16px}
/* the command menu */
.sb-cmd .sb-mbox{max-width:620px}
.sb-cmd input[type=search]{border:0;border-bottom:1px solid var(--rule);border-radius:0;background:transparent;min-height:48px;padding:0 20px;outline:none}
.sb-cmd input[type=search]:focus-visible{outline:none;border-color:var(--rule)}
.sb-cmd ul{list-style:none;max-height:56vh;overflow:auto;padding:6px}
.sb-cmd li.gl{padding:8px 10px 4px;font-size:12px;color:var(--ink3)}
.sb-cmd li a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;color:var(--ink2);text-decoration:none;font-size:14px}
.sb-cmd li a:hover,.sb-cmd li a.on{background:var(--s300);color:var(--ink)}
.sb-cmd li a .ic{color:var(--ink3)}
.sb-cmd .none{padding:16px 20px;color:var(--ink3);font-size:13px}
@media (max-width:900px){
  .sb-page{padding:24px 20px 56px}
  .sb-menu{display:none}
  .sb-search{min-width:0;width:28px;padding:0;justify-content:center}.sb-search span,.sb-search kbd{display:none}
}
@media (max-width:767px){
  .sb-ib.sb-burger{display:inline-flex;margin-left:8px}
  .sb-home{width:40px}
  .sb-rail{position:fixed;left:0;top:48px;height:calc(100vh - 48px);width:0;z-index:60}
  .sb-rail nav{width:0;padding:8px 0;border-right:0}
  body.sb-open .sb-rail nav{width:240px;padding:8px;border-right:1px solid var(--rule);box-shadow:12px 0 24px rgba(0,0,0,.5)}
  body.sb-open .sb-rail a .lbl,body.sb-open .sb-rail a .cnt{opacity:1}
  .sb-cr .nm{max-width:120px}
  .sb-crumbs .bdg,.sb-fb{display:none}
  .sb-page{padding:20px 16px 48px}
  .sb-acts .btn span{display:none}
  .sb-acts .btn{padding:0 8px}
}
@media (max-width:420px){.sb-crumbs .sb-org{display:none}.sb-crumbs .sb-org+.sb-div{display:none}}
`;

// --------------------------------------------------------------------------------------------- copy

/**
 * Copying, for every page: gcCopy copies through a temporary textarea, then the Clipboard API, and when both are
 * refused it selects the text in `node` (a hidden textarea is shown selected) so the person can copy it by hand;
 * copyBtn makes a Copy button; el makes an element with a class and text.
 */
export const COPY_JS = `
function gcSelect(node){
  try { var r = document.createRange(); r.selectNodeContents(node); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); return true; } catch (e) { return false; }
}
// Copy text with the Clipboard API; when the browser refuses (no secure context, the document not focused, an embedded
// page), copy through a temporary textarea and execCommand, which works on the click itself; failing both, select the
// text in node so the person can copy it by hand (a textarea fallback is shown selected: one keystroke copies it).
function gcLegacyCopy(text){
  try {
    var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "0"; ta.style.left = "0"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    var ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
  } catch (e) { return false; }
}
function gcCopy(b, text, node){
  var label = b.getAttribute("data-label") || b.textContent;
  b.setAttribute("data-label", label);
  function say(t){ b.textContent = t; clearTimeout(b.gcT); b.gcT = setTimeout(function(){ b.textContent = label; }, 2000); }
  function fallback(){
    if (node && node.tagName === "TEXTAREA") { node.hidden = false; node.focus(); node.select(); say("Selected, now copy"); return; }
    say(node && gcSelect(node) ? "Selected, now copy" : "Could not copy");
  }
  // the legacy path first: it needs the click's own activation, which the async Clipboard API's rejection would have spent
  if (gcLegacyCopy(text)) { say("Copied"); return; }
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
`;

// --------------------------------------------------------------------------------------------- the frame's script

/**
 * The frame's behaviour: dropdowns, the mobile rail, modals (with their tabs) and the command menu, and one delegated
 * handler for every [data-copy] button (data-target names the element to select when the clipboard is refused).
 * Pages open a modal with data-open="<id>" (data-tab="<tab id>" picks its tab) or gcModal(id, tab).
 */
const STUDIO_JS = `
document.documentElement.classList.add("js");
function gcClose(){
  [].slice.call(document.querySelectorAll(".dd-m:not([hidden])")).forEach(function(m){ m.hidden = true; var b = m.previousElementSibling; if (b) b.setAttribute("aria-expanded", "false"); });
}
function gcTab(btn){
  var list = btn.closest("[role=tablist]"); if (!list) return;
  [].slice.call(list.querySelectorAll("[role=tab]")).forEach(function(t){
    var on = t === btn, p = document.getElementById(t.getAttribute("aria-controls"));
    t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1;
    if (p) p.classList.toggle("on", on);
  });
}
var gcLastFocus = null;
function gcModal(id, tab){
  var m = document.getElementById(id); if (!m) return false;
  gcClose(); gcLastFocus = document.activeElement;
  [].slice.call(document.querySelectorAll(".sb-modal.open")).forEach(function(o){ if (o !== m) o.classList.remove("open"); });
  m.classList.add("open");
  if (tab) { var t = document.getElementById("tab-" + tab); if (t) gcTab(t); }
  var f = m.querySelector("[autofocus], input[type=search]") || m.querySelector(".sb-x");
  if (f) try { f.focus(); } catch (e) {}
  return true;
}
function gcUnmodal(){
  var open = [].slice.call(document.querySelectorAll(".sb-modal.open")); if (!open.length) return false;
  open.forEach(function(m){ m.classList.remove("open"); });
  // a dialog opened from the address (#connect) closes back to the page under it
  if (location.hash === "#connect") try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  if (gcLastFocus && gcLastFocus.focus) try { gcLastFocus.focus(); } catch (e) {}
  return true;
}
document.addEventListener("click", function(e){
  var t = e.target && e.target.closest ? e.target : null; if (!t) return;
  var dd = t.closest("[data-dd]");
  if (dd) {
    var m = dd.nextElementSibling, open = m && m.hidden;
    gcClose();
    if (m && open) { m.hidden = false; dd.setAttribute("aria-expanded", "true"); var f = m.querySelector("a,button"); if (f) try { f.focus(); } catch (x) {} }
    e.preventDefault(); return;
  }
  if (!t.closest(".dd-m")) gcClose();
  var op = t.closest("[data-open]");
  if (op && gcModal(op.getAttribute("data-open"), op.getAttribute("data-tab"))) { e.preventDefault(); return; }
  if (t.closest("[data-close]") || t.classList.contains("sb-modal")) { gcUnmodal(); return; }
  var tab = t.closest("[role=tab]"); if (tab) { gcTab(tab); return; }
  var cp = t.closest("[data-copy]");
  if (cp && typeof gcCopy === "function") {
    // the element to select by hand: data-target, else a copy-prompt block's hidden textarea
    var at = cp.getAttribute("data-target"), ta = cp.parentNode && cp.parentNode.querySelector ? cp.parentNode.querySelector("textarea.cp-text") : null;
    gcCopy(cp, cp.getAttribute("data-copy"), at ? document.getElementById(at) : ta);
    return;
  }
  var rl = t.closest(".sb-rail a");
  if (rl && e.detail) setTimeout(function(){ try { rl.blur(); } catch (x) {} }, 0);
  var bg = t.closest("[data-burger]");
  if (bg) { var on = !document.body.classList.contains("sb-open"); document.body.classList.toggle("sb-open", on); bg.setAttribute("aria-expanded", String(on)); return; }
  if (document.body && document.body.classList.contains("sb-open") && !t.closest(".sb-rail")) document.body.classList.remove("sb-open");
});
document.addEventListener("keydown", function(e){
  if (e.key === "Escape") { if (!gcUnmodal()) gcClose(); document.body && document.body.classList.remove("sb-open"); }
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { if (gcModal("m-cmd")) e.preventDefault(); }
  var tab = e.target && e.target.getAttribute && e.target.getAttribute("role") === "tab" ? e.target : null;
  if (tab && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    var all = [].slice.call(tab.closest("[role=tablist]").querySelectorAll("[role=tab]")), i = all.indexOf(tab);
    var nx = all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]; gcTab(nx); nx.focus(); e.preventDefault();
  }
});
(function(){
  // the command menu: type to filter, arrows to move, Enter to go
  var box = document.getElementById("m-cmd"); if (!box) return;
  var q = box.querySelector("input[type=search]"), items = [].slice.call(box.querySelectorAll("li a")), none = box.querySelector(".none"), cur = 0;
  function vis(){ return items.filter(function(a){ return !a.parentNode.classList.contains("hidden"); }); }
  function mark(){ var v = vis(); items.forEach(function(a){ a.classList.remove("on"); }); if (v[cur]) v[cur].classList.add("on"); }
  function filter(){
    var s = (q.value || "").trim().toLowerCase();
    items.forEach(function(a){ a.parentNode.classList.toggle("hidden", !!s && a.textContent.toLowerCase().indexOf(s) < 0); });
    [].slice.call(box.querySelectorAll("li.gl")).forEach(function(g){
      var n = g.nextElementSibling, any = false;
      while (n && !n.classList.contains("gl")) { if (!n.classList.contains("hidden")) any = true; n = n.nextElementSibling; }
      g.classList.toggle("hidden", !any);
    });
    cur = 0; mark(); if (none) none.classList.toggle("hidden", vis().length > 0);
  }
  if (q) {
    q.addEventListener("input", filter);
    q.addEventListener("keydown", function(e){
      var v = vis();
      if (e.key === "ArrowDown") { cur = Math.min(cur + 1, v.length - 1); mark(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { cur = Math.max(cur - 1, 0); mark(); e.preventDefault(); }
      else if (e.key === "Enter" && v[cur]) { e.preventDefault(); v[cur].click(); }
    });
  }
  items.forEach(function(a){ a.addEventListener("click", function(){ gcUnmodal(); if (q) { q.value = ""; filter(); } }); });
  filter();
})();
`;

// --------------------------------------------------------------------------------------------- the document

/** A link in the rail: its icon, its label (shown when the rail widens) and an optional count (an element id). */
export interface RailItem {
  href: string;
  label: string;
  icon: IconName;
  /** id of a count element the page script fills (e.g. "c-found"). */
  count?: string;
  current?: boolean;
  /** an element id for the link */
  id?: string;
}

/** A product menu: a title and groups of links; `view` shows it only with that view (data-v). */
export interface ProductMenu {
  title: string;
  view?: string;
  groups: { label?: string; items: { href: string; label: string; icon?: IconName; current?: boolean }[] }[];
}

export interface StudioOptions {
  title: string;
  /** An account page: the referrer policy `same-origin` (pages.ts securityHeaders), which the meta tag repeats. */
  account?: boolean;
  /** The organization crumb (the account, its plan) or null on a private link. */
  org: { name: string; plan: string | null; href: string } | null;
  /** The account's projects (apps), for the project switcher and the command menu. */
  projects?: { id: string; name: string }[];
  /** The project crumb on a project's pages; `id` marks it current in the switcher. */
  project?: { name: string; id?: string } | null;
  /** A badge after the project crumb (e.g. the live status), as HTML. */
  status?: string;
  /** The header's Connect button: Studio makes it primary while a project is new. */
  connect?: "primary" | "default" | null;
  /** The signed-in person (the account menu), or null: a Sign in button. */
  user: { label: string; sub?: string } | null;
  /** The rail: groups (a rule between them) and the items pinned to its foot. */
  rail: RailItem[][];
  railEnd?: RailItem[];
  /** The rail's accessible name. */
  railLabel: string;
  /** Product menus (each shown with its view, or always). */
  menus?: ProductMenu[];
  /** Extra command-menu entries, by group. */
  commands?: { group: string; label: string; href: string; icon?: IconName }[];
  /** The page, inside <main>; its first element should be the page's own container. */
  body: string;
  /** The page's script (after the frame's). */
  script: string;
  /** The page's own CSS, after the frame's. */
  css?: string;
}

const railLink = (r: RailItem): string =>
  `<a href="${esc(r.href)}"${r.id ? ` id="${esc(r.id)}"` : ""}${r.current ? ' aria-current="true"' : ""} title="${esc(r.label)}">${icon(r.icon, 20)}<span class="lbl">${esc(r.label)}</span>${
    r.count ? `<span class="cnt" id="${esc(r.count)}"></span>` : ""
  }</a>`;

function productMenu(m: ProductMenu): string {
  const groups = m.groups
    .map(
      (g) =>
        `<div class="g">${g.label ? `<span class="gl">${esc(g.label)}</span>` : ""}${g.items
          .map((i) => `<a href="${esc(i.href)}"${i.current ? ' aria-current="true"' : ""}>${i.icon ? icon(i.icon, 14) : ""}${esc(i.label)}</a>`)
          .join("")}</div>`,
    )
    .join("");
  return `<nav class="sb-pm"${m.view ? ` data-v="${esc(m.view)}"` : ""} aria-label="${esc(m.title)}"><div class="t">${esc(m.title)}</div>${groups}</nav>`;
}

/** The header: home, the organization and project switchers, Connect; Feedback, search, help and the account. */
function header(o: StudioOptions): string {
  const orgMenu = o.org
    ? `<div class="dd sb-org"><button class="sb-cr" type="button" data-dd aria-haspopup="menu" aria-expanded="false"><span class="nm">${esc(o.org.name)}</span>${
        o.org.plan ? badge(o.org.plan) : ""
      }${icon("chevrons", 14)}</button><div class="dd-m" role="menu" hidden><span class="dd-l">Organization</span><a href="${esc(o.org.href)}" aria-current="true">${esc(
        o.org.name,
      )}</a><hr><a href="/account">${icon("box", 14)}All projects</a><a href="/account/billing">${icon("receipt", 14)}Billing</a><a href="/account#settings">${icon(
        "settings",
        14,
      )}Account settings</a></div></div>`
    : `<span class="sb-cr static sb-org"><span class="nm">Private link</span>${badge("Free")}</span>`;
  const p = o.project;
  let projectMenu = "";
  if (p) {
    const list = (o.projects ?? []).map((x) => `<a href="/account/apps/${esc(x.id)}"${x.id === p.id ? ' aria-current="true"' : ""}>${esc(x.name)}</a>`).join("");
    projectMenu = o.org
      ? `${DIVIDER}<div class="dd"><button class="sb-cr" type="button" data-dd aria-haspopup="menu" aria-expanded="false"><span class="nm" id="hname">${esc(p.name)}</span>${icon(
          "chevrons",
          14,
        )}</button><div class="dd-m" role="menu" hidden><span class="dd-l">Projects</span>${list}<hr><a href="/account">${icon("box", 14)}All projects</a><a href="/account/new">${icon(
          "plus",
          14,
        )}New project</a></div></div>`
      : `${DIVIDER}<span class="sb-cr static"><span class="nm" id="hname">${esc(p.name)}</span></span>`;
  }
  const acts = o.connect
    ? `<div class="sb-acts">${o.status ?? ""}<button class="btn sm${o.connect === "primary" ? "" : " ghost"}" type="button" data-open="m-connect" id="hconnect">${icon("plug", 14)}<span>Connect</span></button></div>`
    : o.status
      ? `<div class="sb-acts">${o.status}</div>`
      : "";
  const help = `<div class="dd"><button class="sb-ib" type="button" data-dd aria-haspopup="menu" aria-expanded="false" aria-label="Help">${icon("help", 15)}</button><div class="dd-m end" role="menu" hidden><span class="dd-l">Help</span><a href="https://genclass.dev/docs/dashboard">${icon(
    "book",
    14,
  )}Dashboard guide</a><a href="https://genclass.dev/docs">${icon("book", 14)}Docs</a><a href="https://genclass.dev/docs/mcp">${icon("bot", 14)}MCP server</a><a href="https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md">${icon(
    "file",
    14,
  )}What is collected</a><a href="https://discord.gg/kN9kRnFtZm">${icon("message", 14)}Discord</a></div></div>`;
  const me = o.user
    ? `<div class="dd"><button class="sb-av" type="button" data-dd aria-haspopup="menu" aria-expanded="false" aria-label="Account">${esc((o.user.label.replace(/^@/, "").charAt(0) || "?").toUpperCase())}</button><div class="dd-m end" role="menu" hidden><div class="who">${esc(
        o.user.label,
      )}${o.user.sub ? `<small>${esc(o.user.sub)}</small>` : ""}</div><hr><a href="/account">${icon("box", 14)}All projects</a><a href="/account#settings">${icon("settings", 14)}Account settings</a><a href="/account/billing">${icon(
        "receipt",
        14,
      )}Billing</a><hr><form method="post" action="/logout"><button type="submit">${icon("logout", 14)}Sign out</button></form></div></div>`
    : '<a class="btn sm ghost" href="/login">Sign in</a>';
  return `<header class="sb-top">
<button class="sb-ib sb-burger" type="button" data-burger aria-label="Menu" aria-expanded="false">${icon("menu", 15)}</button>
<a class="sb-home" href="${o.user ? "/account" : "https://genclass.dev/"}" aria-label="${o.user ? "All projects" : "GenClass"}">${MARK}</a>
<nav class="sb-crumbs" aria-label="Breadcrumb">${DIVIDER}${orgMenu}${projectMenu}</nav>
${acts}
<div class="sb-right">
<a class="btn sm ghost sb-fb" href="https://github.com/genclass-dev/GenClass-lib/issues/new">Feedback</a>
<button class="sb-search" type="button" data-open="m-cmd" aria-label="Search">${icon("search", 13)}<span>Search...</span><kbd>⌘K</kbd></button>
${help}
${me}
</div>
</header>`;
}

/** The command menu: every rail link, the product menus, the projects and the page's own commands. */
function commandMenu(o: StudioOptions): string {
  const groups: Record<string, string[]> = {};
  const add = (g: string, label: string, href: string, ic: IconName) => (groups[g] ??= []).push(`<li><a href="${esc(href)}">${icon(ic, 16)}${esc(label)}</a></li>`);
  for (const r of [...o.rail.flat(), ...(o.railEnd ?? [])]) add(o.project ? "Project" : "Organization", r.label, r.href, r.icon);
  for (const m of o.menus ?? []) for (const g of m.groups) for (const i of g.items) add(m.title, i.label, i.href, i.icon ?? "file");
  for (const c of o.commands ?? []) add(c.group, c.label, c.href, c.icon ?? "file");
  for (const p of o.projects ?? []) add("Projects", p.name, `/account/apps/${p.id}`, "box");
  const list = Object.entries(groups)
    .map(([g, items]) => `<li class="gl">${esc(g)}</li>${items.join("")}`)
    .join("");
  return `<div class="sb-modal sb-cmd" id="m-cmd" role="dialog" aria-modal="true" aria-label="Command menu"><div class="sb-mbox">
<input type="search" placeholder="Type a command or search..." aria-label="Search" autocomplete="off" spellcheck="false">
<ul>${list}</ul><p class="none hidden">No results.</p></div></div>`;
}

/**
 * The whole document: head (fonts, the frame's CSS, the page's CSS), the header, the rail, the product menus, <main>
 * with the page, the command menu, and one script (the copy helpers, the frame, the page).
 */
export function studioPage(nonce: string, o: StudioOptions): string {
  const rail = o.rail.map((g) => g.map(railLink).join("")).join("<hr>");
  const end = o.railEnd?.length ? `<div class="end">${o.railEnd.map(railLink).join("")}</div>` : "";
  const menus = o.menus?.length ? `<aside class="sb-menu">${o.menus.map(productMenu).join("")}</aside>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="${o.account ? "same-origin" : "no-referrer"}">
<title>${esc(o.title)}</title>
${ICON_LINKS}
<meta name="theme-color" content="#121212">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Source+Code+Pro:wght@400;500&display=swap">
<style nonce="${nonce}">${STUDIO_CSS}${o.css ?? ""}</style>
</head>
<body class="sb">
<a class="skip" href="#mc">Skip to content</a>
${header(o)}
<div class="sb-body">
<div class="sb-rail"><nav class="snav" id="snav" aria-label="${esc(o.railLabel)}">${rail}${end}</nav></div>
${menus}
<main class="wrap" id="main">${o.body}</main>
</div>
${commandMenu(o)}
<script nonce="${nonce}">${COPY_JS}${STUDIO_JS}${o.script}</script>
</body>
</html>`;
}
