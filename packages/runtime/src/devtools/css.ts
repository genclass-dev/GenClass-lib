// Devtools stylesheet, in genclass.dev's black design (site/src/css/base.css): black ground, raised panels, bone
// text, the GenClass mark's green for what GenClass changed and red-orange for the bugs it catches, amber for
// warnings, square corners, 1px rules, no shadows. Black is the default whatever the page's or the OS's theme
// (`theme: "light"`, or "auto" on a light OS, gives the same design on white). Type is the system UI font and a
// system mono stack: the overlay loads no web font and names none a page might declare (no Inter, no JetBrains
// Mono), so it never makes a request of its own. Lives only inside the overlay's shadow root: nothing here can reach
// the host page. Text colours are at least 4.5:1 on every ground they sit on, in both themes.

// --go: green text and marks, --go-f its fills (with --go-ink on them); --bug: red-orange text, --bug-f its fills;
// --amb: amber. The -bg and -line variants are their tints and rules.
const DARK = `--bg:#000;--bg2:#0B0B0A;--bg3:#131311;--line:#30312B;--line2:#46463E;--fg:#F0F1E9;--fg2:#A0A196;--fg3:#88897F;
--go:#2FD07F;--go-f:#2FD07F;--go-ink:#02140A;--go-bg:rgba(47,208,127,.08);--go-line:rgba(47,208,127,.35);
--bug:#FF6B4A;--bug-f:#FF5A36;--bug-bg:rgba(255,90,54,.1);--bug-line:rgba(255,90,54,.4);
--amb:#F5C66A;--amb-bg:rgba(245,198,106,.09);--amb-line:rgba(245,198,106,.32);color-scheme:dark;`;

const LIGHT = `--bg:#fff;--bg2:#F7F7F3;--bg3:#EEEFE8;--line:#DCDDD4;--line2:#B9BAB0;--fg:#0B0B0A;--fg2:#4E4F47;--fg3:#66675E;
--go:#0A7A45;--go-f:#2FD07F;--go-ink:#02140A;--go-bg:rgba(47,208,127,.13);--go-line:rgba(10,122,69,.4);
--bug:#C2402A;--bug-f:#FF5A36;--bug-bg:rgba(255,90,54,.09);--bug-line:rgba(194,64,42,.4);
--amb:#8A5A00;--amb-bg:rgba(245,198,106,.2);--amb-line:rgba(138,90,0,.32);color-scheme:light;`;

export const CSS = `
*,*::before,*::after{box-sizing:border-box}
.root{${DARK}
--font:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
position:relative;display:flex;font:400 13px/1.45 var(--font);color:var(--fg);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
text-align:left;letter-spacing:0;font-variant-numeric:tabular-nums}
.root[data-theme=light]{${LIGHT}}
.root[data-pos^=top]{align-items:flex-start}
.root[data-pos$=left]{justify-content:flex-start}
.root[data-pos$=right]{justify-content:flex-end}
button{font:inherit;color:inherit;background:none;border:0;border-radius:0;padding:0;margin:0;cursor:pointer;text-align:inherit;-webkit-tap-highlight-color:transparent}
button:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:1px solid var(--go);outline-offset:1px}
input,select{font:inherit;color:inherit}
svg{display:block;flex:none}
.i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
[hidden]{display:none!important}
code,.mono{font-family:var(--mono)}

/* the mark: the gap around the red arrowhead is the ground it sits on */
.mark{width:22px;height:22px}
.mark .mg{fill:var(--bg);stroke:var(--bg);stroke-width:36;stroke-linejoin:round}

/* pill */
.pill{position:relative;display:flex;align-items:center;gap:9px;height:38px;padding:0 13px 0 9px;background:var(--bg);
border:1px solid var(--line2);font-size:12.5px;font-weight:500;color:var(--fg);transition:border-color .15s}
.pill:hover{border-color:var(--fg3)}
.pill:focus-visible{outline-offset:3px}
.pn{font-weight:600;letter-spacing:-.01em}
.pm{margin-left:-3px;font:400 11px var(--mono);color:var(--fg3)}
.vs{width:1px;height:16px;background:var(--line2)}
.pc{display:inline-flex;align-items:center;gap:4px;color:var(--fg3)}
.pc .i{width:14px;height:14px}
.pc b{font:500 12px var(--mono)}
.pc.on.a{color:var(--go)}
.pc.on.d{color:var(--bug)}
.pd{width:7px;height:7px;background:var(--fg3);margin-left:1px}
.s-ready .pd,.s-ready .dot{background:var(--go-f)}
.s-error .pd,.s-error .dot{background:var(--bug-f)}
.s-loading .pd,.s-loading .dot{background:var(--fg);animation:blink 1.1s ease-in-out infinite}
.pb{position:absolute;left:12px;right:12px;bottom:3px;height:2px;background:var(--bg3);overflow:hidden}
.pb i,.sb i{display:block;height:100%;width:0;background:var(--go-f);transition:width .3s ease}
.pill::after{content:"";position:absolute;inset:-1px;pointer-events:none;opacity:0;outline:1px solid var(--ring,transparent);outline-offset:0}
.pill.pa::after{--ring:var(--go);animation:ring 1.5s cubic-bezier(.2,.7,.3,1)}
.pill.pdd::after{--ring:var(--bug);animation:ring 1.5s cubic-bezier(.2,.7,.3,1)}
.pill.pa .pc.a b,.pill.pdd .pc.d b{animation:bump .5s cubic-bezier(.2,.8,.2,1)}
@keyframes ring{0%{opacity:.9;outline-offset:0}100%{opacity:0;outline-offset:12px}}
@keyframes bump{40%{transform:scale(1.25)}}
@keyframes blink{50%{opacity:.35}}
@keyframes spin{to{transform:rotate(360deg)}}

/* panel */
.panel{display:flex;flex-direction:column;width:min(444px,calc(100vw - 24px));height:min(660px,calc(100vh - 24px));background:var(--bg);
border:1px solid var(--line2);overflow:hidden;animation:pop .2s cubic-bezier(.2,.8,.2,1)}
.root[data-pos^=bottom] .panel{transform-origin:bottom right}
.root[data-pos^=top] .panel{transform-origin:top right;animation-name:popd}
@keyframes pop{from{opacity:0;transform:translateY(10px)}}
@keyframes popd{from{opacity:0;transform:translateY(-10px)}}
.hd{display:flex;align-items:center;gap:8px;padding:10px 8px 10px 12px}
.brand{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:8px;flex:1;min-width:0}
.brand .mark{grid-row:span 2;width:24px;height:24px}
.bn,.bt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bn{font-weight:600;font-size:14px;line-height:16px;letter-spacing:-.02em}
.bt{font:400 10px/13px var(--mono);color:var(--fg3)}
.modes{display:flex;flex:none;border:1px solid var(--line)}
.modes button{display:flex;align-items:center;gap:5px;height:24px;padding:0 8px;font-size:12px;font-weight:500;color:var(--fg3);transition:color .15s,background .15s}
.modes button+button{border-left:1px solid var(--line)}
.modes button:hover{color:var(--fg)}
.modes button[aria-checked=true]{background:var(--bg3);color:var(--fg)}
.modes button:focus-visible{outline-offset:-1px}
.modes .md{display:none;width:6px;height:6px;background:var(--fg3)}
.modes [aria-checked=true] .md{display:block}
.m-observe .md{background:var(--fg)}.m-guard .md{background:var(--go-f)}.m-heal .md{background:var(--amb)}
.aggr{flex:none;height:26px;padding:0 2px;border:1px solid var(--line);border-radius:0;background:var(--bg);color:var(--fg2);font-size:12px;cursor:pointer}
.aggr:hover{border-color:var(--line2);color:var(--fg)}
.ib{display:grid;place-items:center;flex:none;width:28px;height:28px;color:var(--fg2);transition:background .12s,color .12s}
.ib:hover{background:var(--bg3);color:var(--fg)}
.ib[aria-pressed=true]{color:var(--amb);background:var(--amb-bg)}

.st{position:relative;display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 14px;font-size:12px;color:var(--fg2);
background:var(--bg2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.st b{font-weight:600;color:var(--fg);white-space:nowrap}
.dot{width:7px;height:7px;background:var(--fg3);flex:none;margin-right:2px}
.sm{margin-left:auto;font:400 11px/1.4 var(--mono);color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.s-error .sm{color:var(--bug)}
.sb{position:absolute;left:0;right:0;bottom:-1px;height:2px}

/* tabs: they scroll sideways when the panel is narrower than all six, fading out at the right edge (the spacer after
   the last tab, and the scroll padding for a tab scrolled into view, keep tabs clear of the fade) */
.tabs{display:flex;align-items:center;gap:2px;padding:0 6px 0 0;border-bottom:1px solid var(--line)}
.tabs-in{display:flex;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;scroll-padding-inline:0 22px;
-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 22px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 22px),transparent)}
.tabs-in::-webkit-scrollbar{display:none}
.tabs-in::after{content:"";flex:none;width:18px}
.tab{position:relative;flex:none;display:flex;align-items:center;gap:6px;height:38px;padding:0 10px;font-size:12.5px;font-weight:500;color:var(--fg3);transition:color .15s,background .15s}
.tab:hover{color:var(--fg)}
.tab[aria-selected=true]{color:var(--fg);background:var(--bg2)}
.tab[aria-selected=true]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--go-f)}
.tab:focus-visible{outline-offset:-1px}
.n{display:inline-grid;place-items:center;min-width:18px;height:17px;padding:0 4px;border:1px solid var(--line2);color:var(--fg3);font:500 10.5px var(--mono)}
.ta .n.on{background:var(--go-bg);border-color:var(--go-line);color:var(--go)}
.td .n.on,.tc .n.on{background:var(--bug-bg);border-color:var(--bug-line);color:var(--bug)}
.sp{flex:1}
.pz{display:flex;align-items:center;gap:8px;padding:6px 14px;font-size:12px;font-weight:500;color:var(--amb);background:var(--amb-bg);border-bottom:1px solid var(--amb-line)}
.pz .i{width:14px;height:14px}
.pz button{margin-left:auto;font-weight:600;text-decoration:underline;text-underline-offset:3px}

.body{position:relative;flex:1;min-height:0}
.pane{position:absolute;inset:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
.pane::-webkit-scrollbar{width:10px}
.pane::-webkit-scrollbar-thumb{background:var(--line2);border:3px solid var(--bg)}
.list{display:flex;flex-direction:column;gap:8px;padding:10px}

/* cards */
.card{display:flex;gap:11px;padding:12px 14px 8px 12px;border:1px solid var(--line);background:var(--bg2);transition:border-color .15s}
.card:hover{border-color:var(--line2)}
.card.new{animation:enter .45s cubic-bezier(.2,.8,.2,1)}
@keyframes enter{0%{opacity:0;transform:translateY(-6px);border-color:var(--go-line)}60%{border-color:var(--go-line)}}
.ci{display:grid;place-items:center;width:28px;height:28px;flex:none;color:var(--go);background:var(--go-bg);border:1px solid var(--go-line)}
.det .ci{color:var(--bug);background:var(--bug-bg);border-color:var(--bug-line)}
.ci .i{width:15px;height:15px}
.cb{flex:1;min-width:0}
.ch{display:flex;align-items:baseline;gap:8px;min-height:20px}
.ct{flex:1;min-width:0;font-weight:600;letter-spacing:-.01em;line-height:1.35;padding-top:3px}
.ago{font:400 11px var(--mono);color:var(--fg3);white-space:nowrap}
.rep{align-self:center;height:18px;padding:0 5px;font:500 11px/16px var(--mono);color:var(--bug);background:var(--bug-bg);border:1px solid var(--bug-line)}
.cx{margin:3px 0 0;font-size:12.5px;line-height:1.5;color:var(--fg2);overflow-wrap:anywhere}
.cx{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 7px;font:400 11px var(--mono);
color:var(--fg2);background:var(--bg3);border:1px solid var(--line);white-space:nowrap}
.chip b{font-weight:500;color:var(--fg)}
.chip .p{color:var(--fg2)}
.chip .cd{width:6px;height:6px;background:var(--fg3)}
.t-brand .cd{background:var(--fg)}.t-warn .cd{background:var(--amb)}.t-bad .cd{background:var(--bug-f)}.t-ok .cd{background:var(--go-f)}
.chip code{font-size:11px;font-weight:500;color:var(--fg)}
.chip .tier{color:var(--fg3)}
.chip .tier::before{content:"·";margin-right:5px}
.note{display:flex;gap:8px;margin-top:8px;padding:7px 10px;font-size:12px;line-height:1.45;color:var(--fg2);background:var(--bg3);border:1px solid var(--line)}
.note .i{width:14px;height:14px;margin-top:1.5px;color:var(--fg3)}
.note b{font-weight:600;color:var(--fg)}
.note code{font-size:11.5px;color:var(--fg)}
.note.chg{background:var(--go-bg);border-color:var(--go-line);color:var(--fg)}
.note.chg .i{color:var(--go)}
.note.fail{background:var(--bug-bg);border-color:var(--bug-line);color:var(--bug)}
.note.fail .i{color:var(--bug)}
.cf{display:flex;align-items:center;gap:2px;margin:7px 0 0 -7px}
.btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;font-size:12px;font-weight:500;color:var(--fg2);transition:background .12s,color .12s}
.btn:hover{background:var(--bg3);color:var(--fg)}
.btn .i{width:14px;height:14px}
.btn.u{color:var(--go)}
.btn.u:hover{background:var(--go-bg)}
.btn .chev{width:13px;height:13px;transition:transform .18s}
.btn[aria-expanded=true] .chev{transform:rotate(90deg)}
.done{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;font-size:12px;font-weight:500;color:var(--go)}
.done .i{width:14px;height:14px}
.err{font-size:12px;color:var(--bug);padding:0 8px}
.card.possible{border-style:dashed;opacity:.72}
.card.possible .ci{color:var(--fg3);background:var(--bg3);border-color:var(--line)}
.chip.poss{color:var(--fg3);border-style:dashed}
.card.undone .ci{color:var(--fg3);background:var(--bg3);border-color:var(--line)}
.card.undone .ct{color:var(--fg2)}

/* evidence */
.evd{display:flex;flex-direction:column;gap:14px;margin:6px 0 4px;padding-top:12px;border-top:1px solid var(--line)}
.sec h4{display:flex;align-items:center;gap:6px;margin:0 0 7px;font:500 10.5px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--fg3)}
.sec h4 .sp{flex:1}
.facts{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.facts li{position:relative;padding-left:14px;font-size:12px;line-height:1.5;color:var(--fg2)}
.facts li::before{content:"";position:absolute;left:3px;top:.62em;width:4px;height:4px;background:var(--fg3)}
.code{margin:0;padding:8px 10px;background:var(--bg);border:1px solid var(--line2);font:11px/1.6 var(--mono);color:var(--fg2);
white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
.ans{display:grid;grid-template-columns:96px 1fr 34px;gap:5px 10px;align-items:center}
.ans+.ans{margin-top:10px}
.aq{grid-column:1/-1;font-size:11.5px;font-weight:500;color:var(--fg2)}
.bl{font:11px/1.4 var(--mono);color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt2{height:6px;background:var(--bg3);overflow:hidden}
.bt2 i{display:block;height:100%;background:var(--fg3)}
.bp{font:11px var(--mono);text-align:right;color:var(--fg3)}
.bl.top,.bp.top{color:var(--fg);font-weight:600}
.bt2.top i{background:var(--go-f)}
.meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--fg3)}
.meta code{font-size:10.5px;color:var(--fg2)}
.cp{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;font:500 10.5px var(--mono);letter-spacing:.02em;text-transform:none;color:var(--fg3)}
.cp:hover{background:var(--bg3);color:var(--fg)}
.cp .i{width:12px;height:12px}

/* empty states */
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:5px;padding:56px 32px;color:var(--fg3);font-size:12.5px;line-height:1.5}
.empty .ei{display:grid;place-items:center;width:40px;height:40px;margin-bottom:8px;border:1px solid var(--line2);color:var(--fg3)}
.empty .ei .i{width:18px;height:18px}
.empty b{font-size:13.5px;font-weight:600;color:var(--fg)}

/* activity */
.fb{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:7px 10px;background:var(--bg);border-bottom:1px solid var(--line)}
.f{display:inline-flex;align-items:center;height:22px;padding:0 7px;font:400 11px var(--mono);color:var(--fg3);border:1px solid var(--line);transition:color .12s,background .12s,border-color .12s}
.f[aria-pressed=true]{color:var(--fg);background:var(--bg3);border-color:var(--line2)}
.f.g-state[aria-pressed=true]{color:var(--amb)}.f.g-error[aria-pressed=true]{color:var(--bug)}.f.g-gc[aria-pressed=true]{color:var(--go)}
.f[aria-pressed=false]{text-decoration:line-through;opacity:.7}
.q{flex:1;min-width:60px;height:22px;padding:0 8px;border:1px solid var(--line);border-radius:0;background:var(--bg);font:400 11px var(--mono);outline:none;-webkit-appearance:none;appearance:none}
.q:focus{border-color:var(--go)}
.q::placeholder{color:var(--fg3)}
.evs{padding:4px 0 10px}
.ev{display:grid;grid-template-columns:48px 44px minmax(0,1fr) auto;gap:8px;align-items:baseline;padding:3.5px 12px;font-size:12px;cursor:pointer}
.ev:hover{background:var(--bg2)}
.ev .t{font:10.5px/1.5 var(--mono);color:var(--fg3);text-align:right}
.ev .k{font:500 9.5px/17px var(--mono);letter-spacing:.04em;text-transform:uppercase;text-align:center;color:var(--fg2);background:var(--bg3)}
.g-user .k{color:var(--fg);outline:1px solid var(--line2);outline-offset:-1px}
.g-op .k{color:var(--fg2)}
.g-state .k{color:var(--amb);background:var(--amb-bg)}
.g-error .k{color:var(--bug);background:var(--bug-bg)}
.g-gc .k{color:var(--go);background:var(--go-bg)}
.ev .m{color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ev .id{margin-left:6px;font:10.5px var(--mono);color:var(--fg3)}
.ev .x{display:flex;align-items:center;gap:6px;font:11px var(--mono);color:var(--fg3);white-space:nowrap}
.x .ok{color:var(--go)}.x .bad{color:var(--bug)}.x .brand{color:var(--go)}.x .dim{color:var(--fg3)}
.ev.open{background:var(--bg2)}
.ev.open .m{white-space:normal;overflow-wrap:anywhere}
.evx{grid-column:3/-1;margin:2px 0 4px;font:10.5px/1.6 var(--mono);color:var(--fg2);white-space:pre-wrap;overflow-wrap:anywhere}
.ev.fresh{animation:fresh 1.2s ease-out}
@keyframes fresh{from{background:var(--go-bg)}}
.spin{width:10px;height:10px;border-radius:50%;border:1.5px solid var(--line2);border-top-color:var(--go);animation:spin .8s linear infinite}

/* now */
.now{display:flex;flex-direction:column;gap:14px;padding:12px 14px 16px}
.nh{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--fg3)}
.live{display:inline-flex;align-items:center;gap:6px;font:500 10.5px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--go)}
.live::before{content:"";width:6px;height:6px;background:currentColor;animation:blink 1.6s ease-in-out infinite}
.paused .live{color:var(--fg3)}.paused .live::before{animation:none}
.subj{padding:11px 12px;border:1px solid var(--line);background:var(--bg2)}
.subj p{margin:7px 0 0;font-size:12.5px;line-height:1.5;color:var(--fg)}
.kv{display:flex;flex-direction:column;gap:3px}
.op{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:7px 10px;border:1px solid var(--line);font-size:12px}
.op+.op{margin-top:5px}
.op .m{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.op .x{display:flex;align-items:center;gap:6px;font:11px var(--mono);color:var(--fg3)}
.none{font-size:12px;color:var(--fg3)}
.acts{display:flex;flex-wrap:wrap;gap:6px}
.m0{margin:0}
.chk .ci{color:var(--bug);background:var(--bug-bg);border-color:var(--bug-line)}
.chk.sev-medium .ci{color:var(--amb);background:var(--amb-bg);border-color:var(--amb-line)}
.chk.sev-low .ci{color:var(--fg2);background:var(--bg3);border-color:var(--line)}
.badge{font:500 10px/1.6 var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--fg2);background:var(--bg3);border:1px solid var(--line);padding:0 5px}
.hl{position:fixed;pointer-events:none;border:2px solid var(--bug-f);box-shadow:0 0 0 4000px rgba(0,0,0,.08);z-index:1;transition:opacity .3s}

@media (prefers-reduced-motion:reduce){.root *,.root *::before,.root *::after{animation:none!important;transition:none!important}}
`;
