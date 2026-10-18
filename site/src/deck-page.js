// genclass.dev/admin/deck: the pitch deck's share links, per-slide aggregates and views. Served behind the admin session
// (src/admin.js) under its strict CSP; the script is /admin/deck.js and only ever sets textContent. "This browser is
// ours" uses the same localStorage keys as the viewer (deck.viewer, deck.owner): both pages are on genclass.dev. Its look
// (fonts, colour tokens, header, buttons, tables) is the dashboard's, from src/admin-page.js.
import { BASE_CSS, FONTS } from "./admin-page.js";

export const DECK_ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#000000"><title>Pitch deck views</title><link rel="icon" href="/brand/mark-32.png?v=2">${FONTS}
<style>${BASE_CSS}
body{font-size:14px}
.top h1{font:500 17px var(--display);letter-spacing:-.02em;padding-left:16px;border-left:1px solid var(--rule-strong);line-height:24px}
.top .sub{font-family:var(--mono);font-size:12.5px}
.top nav{margin-left:auto;display:flex;flex-wrap:wrap;gap:8px}
main{max-width:1400px;margin:0 auto;padding:24px 20px 40px;display:grid;gap:16px}
h2{font:500 15px var(--sans);letter-spacing:-.01em;margin-bottom:12px;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}h2 small{font:400 12.5px/1.5 var(--sans);color:var(--faint);letter-spacing:0}
.sub{color:var(--faint);font-size:13px}
.card{background:var(--raised);border:1px solid var(--rule);padding:18px 20px 20px;min-width:0}
.scroll{overflow:auto}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
main button{display:inline-flex;align-items:center;justify-content:center;min-height:30px;border:1px solid var(--rule-strong);border-radius:0;background:transparent;color:var(--dim);padding:0 10px;font:500 12.5px var(--sans);cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s,opacity .15s}
main button:hover{color:var(--bone);border-color:var(--faint)}
main button.primary{min-height:38px;padding:0 16px;font-size:13.5px;background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}main button.primary:hover{opacity:.9;color:var(--accent-ink);border-color:var(--accent)}
input[type=text]{min-height:38px;border:1px solid var(--line);border-radius:0;background:var(--ground);color:var(--bone);padding:0 12px;min-width:min(280px,100%);font-size:14px;transition:border-color .15s}
input[type=text]::placeholder{color:var(--faint)}
input[type=text]:focus,select:focus{outline:0;border-color:var(--accent)}
select{appearance:none;-webkit-appearance:none;min-height:34px;border:1px solid var(--line);border-radius:0;color:var(--bone);padding:0 32px 0 10px;font-size:13px;background:var(--ground) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%2388897F' stroke-width='1.4'/%3E%3C/svg%3E") right 10px center/12px no-repeat;max-width:100%}
label.sub{display:inline-flex;align-items:center;gap:8px;cursor:pointer}
table{font-size:13px}
th{padding:8px 8px 8px 0;font-size:11px;letter-spacing:.04em;white-space:nowrap}
td{padding:8px 8px 8px 0;vertical-align:middle;white-space:nowrap}
td.n{font-size:12.5px}
td.ms{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--dim);font-size:12px;text-align:right}
td.ms b{display:block;height:3px;background:var(--dim);margin-top:3px;margin-left:auto}
td.z{color:var(--faint)}
.views table{min-width:1100px}.links table{min-width:1000px}
.pill{margin-left:6px}
.pill.off{color:var(--bad);border-color:rgba(255,90,54,.45)}.pill.ours{color:var(--warn);border-color:rgba(245,198,106,.4)}
.path{font-family:var(--mono);color:var(--faint);font-size:12px;white-space:normal;min-width:120px}
code{font-size:11.5px;color:var(--dim)}
.empty{padding:12px 14px}
.meter{display:inline-block;vertical-align:middle;width:120px;height:6px;background:var(--raised2);overflow:hidden;margin-left:10px}
.meter i{display:block;height:100%;background:var(--bone)}.meter.red i{background:var(--bad)}
.spark{display:inline-flex;align-items:flex-end;gap:2px;height:22px;vertical-align:middle}
.spark i{display:block;width:7px;background:var(--dim);min-height:1px}
.err{color:var(--bad);font-size:13px}
@media (max-width:720px){.top nav{margin-left:0;width:100%}}
@media (max-width:620px){main{padding:16px 16px 32px;gap:12px}.card{padding:16px}.top h1{padding-left:12px}}
</style></head><body>
<header class="top"><div class="in">
<a class="logo" href="/"><img src="/brand/mark-64.png?v=2" alt="" width="24" height="24">GenClass</a><h1>Pitch deck</h1><span class="sub" id="sub">loading…</span>
<nav><a class="btn" href="/admin">Dashboard</a><a class="btn" href="/pitch-deck" target="_blank" rel="noopener">Open the deck</a><a class="btn" href="/admin/logout">Sign out</a></nav></div></header>
<main>
<section class="card"><h2>This browser</h2><div class="row"><span id="me-t" class="sub"></span><button type="button" id="me-b"></button></div></section>
<section class="card links"><h2>Share links <small>genclass.dev/pitch-deck?k=… The token is random and says nothing about the name. A disabled link's new views count as the direct link (the deck stays public).</small></h2>
<form class="row" id="new"><input type="text" id="new-name" maxlength="80" placeholder="Name, e.g. a fund or a person" aria-label="New link name" required><button class="primary" type="submit">Create link</button><span class="err" id="new-err" role="alert"></span></form>
<div class="scroll" id="links" style="margin-top:14px"></div></section>
<section class="card"><h2>Slides <small id="agg-sub"></small></h2><div class="scroll" id="agg"></div></section>
<section class="card views"><h2>Views <small id="views-sub"></small></h2>
<div class="row" style="margin-bottom:10px"><label class="sub" for="filter">Link</label><select id="filter"></select>
<label class="sub"><input type="checkbox" id="own"> Show our own views</label></div>
<p class="sub" style="margin-bottom:10px">One row per page load. Slide times count only while the deck was on screen in a visible tab with the window focused. Browser: a random id kept in that browser, so repeat visits show as visit 2, 3…</p>
<div class="scroll" id="views"></div></section>
</main><script src="/admin/deck.js" defer></script></body></html>`;

export const DECK_ADMIN_JS = String.raw`(() => {
const $ = (id) => document.getElementById(id);
const E = (tag, attrs, kids) => { const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === "text") e.textContent = v; else if (k === "cls") e.className = v; else if (v !== undefined && v !== null) e.setAttribute(k, v); }
  for (const c of [].concat(kids || [])) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e; };
const dur = (ms) => { if (ms === null || ms === undefined) return "–"; if (!ms) return "0 s"; const s = ms / 1000; if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + " s";
  const m = Math.floor(s / 60), r = Math.round(s % 60); if (m < 60) return m + " m " + String(r).padStart(2, "0") + " s";
  return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " m"; };
const when = (iso) => { if (!iso) return "–"; const d = new Date(iso); return isNaN(d) ? "–" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
const pct = (x) => Math.round(100 * x) + "%";
const meter = (share, cls) => { const m = E("span", { cls: "meter" + (cls ? " " + cls : "") }); const i = E("i"); i.style.width = Math.round(100 * Math.min(1, share)) + "%"; m.append(i); return m; };
const shareUrl = (token) => location.origin + "/pitch-deck?k=" + token;

let link = "all", own = false, data = null;
try { const s = JSON.parse(localStorage.getItem("gc-deck-admin") || "{}"); if (s.link) link = String(s.link); own = !!s.own; } catch (e) {}
const save = () => { try { localStorage.setItem("gc-deck-admin", JSON.stringify({ link: link, own: own })); } catch (e) {} };

// ---- this browser: the viewer's own localStorage keys (same origin)
const ID = /^[A-Za-z0-9_-]{22}$/;
function browserId() {
  let v = null; try { v = localStorage.getItem("deck.viewer"); } catch (e) {}
  if (ID.test(v || "")) return v;
  const b = new Uint8Array(16); crypto.getRandomValues(b); let s = ""; for (const x of b) s += String.fromCharCode(x);
  v = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try { localStorage.setItem("deck.viewer", v); return localStorage.getItem("deck.viewer") === v ? v : null; } catch (e) { return null; }
}
const isOurs = () => { try { return localStorage.getItem("deck.owner") === "1"; } catch (e) { return false; } };
function renderMe() {
  const ours = isOurs(), n = data ? data.ourBrowsers : 0;
  $("me-t").textContent = (ours ? "This browser is marked as ours: its views of the deck are stored but left out of everything below unless you tick Show our own views."
    : "This browser is not marked. Mark it so your own views of the deck do not count.") + (n ? " Browsers marked: " + n + "." : "");
  $("me-b").textContent = ours ? "Unmark this browser" : "This browser is ours";
}
$("me-b").addEventListener("click", async () => {
  const viewer = browserId();
  if (!viewer) { $("me-t").textContent = "This browser blocks localStorage, so it cannot be marked."; return; }
  const on = !isOurs();
  const r = await post("/admin/api/deck/owner", { viewer: viewer, on: on });
  if (!r) return;
  try { if (on) localStorage.setItem("deck.owner", "1"); else localStorage.removeItem("deck.owner"); } catch (e) {}
  load();
});

async function post(url, body) {
  try {
    const r = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) { location.reload(); return null; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(j.error || ("HTTP " + r.status)); return null; }
    return j;
  } catch (e) { alert("Request failed: " + e.message); return null; }
}

// ---- share links
$("new").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("new-name").value.trim();
  if (!name) return;
  const r = await post("/admin/api/deck/links", { action: "create", name: name });
  if (r && r.link) { $("new-name").value = ""; try { await navigator.clipboard.writeText(shareUrl(r.link.token)); $("new-err").textContent = "Created; URL copied."; } catch (err) { $("new-err").textContent = "Created."; } load(); }
});
function compact(per, views) {
  const box = E("span", { cls: "spark", title: per.map((s) => "Slide " + s.slide + ": reached " + s.reached + "/" + views + ", median " + dur(s.medianMs) + ", stopped here " + pct(s.dropOff)).join("\n") });
  for (const s of per) { const i = E("i"); i.style.height = Math.max(1, Math.round(22 * s.reachedShare)) + "px"; box.append(i); }
  return box;
}
function renderLinks(d) {
  const el = $("links"); el.replaceChildren();
  const head = ["Link", "URL", "Views", "Browsers", "Time read", "Median view", "Finished", "Last viewed", "Reach by slide", ""].map((t, i) => E("th", { cls: i >= 2 && i <= 6 ? "n" : "", text: t }));
  const rows = d.links.map((l) => {
    const url = l.token ? shareUrl(l.token) : null;
    const copy = url ? E("button", { type: "button", text: "Copy" }) : null;
    if (copy) copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(url); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1500); } catch (e) { prompt("Copy the link:", url); } });
    const actions = [];
    if (l.id) {
      const ren = E("button", { type: "button", text: "Rename" });
      ren.addEventListener("click", async () => { const name = prompt("New name for this link:", l.name); if (name && name.trim()) { await post("/admin/api/deck/links", { action: "rename", id: l.id, name: name }); load(); } });
      const dis = E("button", { type: "button", text: l.disabled ? "Enable" : "Disable" });
      dis.addEventListener("click", async () => { await post("/admin/api/deck/links", { action: l.disabled ? "enable" : "disable", id: l.id }); load(); });
      actions.push(ren, " ", dis, " ");
    }
    const show = E("button", { type: "button", text: "Views" });
    show.addEventListener("click", () => { link = l.key; save(); load(); });
    actions.push(show);
    return E("tr", {}, [
      E("td", {}, [l.name, l.disabled ? E("span", { cls: "pill off", text: "disabled" }) : null]),
      E("td", {}, url ? [E("code", { text: url.replace(/^https?:\/\//, "") }), " ", copy] : E("span", { cls: "sub", text: "genclass.dev/pitch-deck" })),
      E("td", { cls: "n", text: String(l.views) }), E("td", { cls: "n", text: String(l.browsers) }), E("td", { cls: "n", text: dur(l.totalMs) }),
      E("td", { cls: "n", text: dur(l.medianMs) }), E("td", { cls: "n", text: l.views ? l.completed + " (" + pct(l.completed / l.views) + ")" : "–" }),
      E("td", { text: when(l.lastView) }), E("td", {}, l.views ? compact(l.perSlide, l.views) : E("span", { cls: "sub", text: "–" })), E("td", {}, actions)]);
  });
  el.append(E("table", {}, [E("thead", {}, E("tr", {}, head)), E("tbody", {}, rows)]));
}

// ---- per-slide aggregates for the selected link
function renderAgg(d) {
  const a = d.selection, el = $("agg"); el.replaceChildren();
  $("agg-sub").textContent = label(d) + " · " + a.views + " view" + (a.views === 1 ? "" : "s") + ", " + a.browsers + " browser" + (a.browsers === 1 ? "" : "s") +
    " · median view " + dur(a.medianMs) + ", mean " + dur(a.meanMs) + (a.views ? " · " + pct(a.completed / a.views) + " reached the last slide" : "");
  if (!a.views) { el.append(E("p", { cls: "empty", text: "No views for this selection yet." })); return; }
  const head = ["Slide", "Reached", "Median time", "Mean time", "Stopped here (drop-off)"].map((t, i) => E("th", { cls: i === 2 || i === 3 ? "n" : "", text: t }));
  const rows = a.perSlide.map((s) => E("tr", {}, [
    E("td", { text: String(s.slide) }),
    E("td", {}, [s.reached + " (" + pct(s.reachedShare) + ")", meter(s.reachedShare)]),
    E("td", { cls: "n", text: dur(s.medianMs) }), E("td", { cls: "n", text: dur(s.meanMs) }),
    E("td", {}, [s.left + " (" + pct(s.dropOff) + ")", meter(s.dropOff, "red")])]));
  el.append(E("table", {}, [E("thead", {}, E("tr", {}, head)), E("tbody", {}, rows)]));
}
function label(d) { if (link === "all") return "all links"; const l = d.links.find((x) => x.key === link); return l ? l.name : "unknown link"; }

// ---- views
function renderFilter(d) {
  const sel = $("filter"); sel.replaceChildren(E("option", { value: "all", text: "All links" }));
  for (const l of d.links) sel.append(E("option", { value: l.key, text: l.name + (l.disabled ? " (disabled)" : "") + " · " + l.views }));
  sel.value = link; if (sel.value !== link) { link = "all"; sel.value = "all"; }
  $("own").checked = own;
}
function renderViews(d) {
  const n = d.slides, el = $("views"); el.replaceChildren();
  $("views-sub").textContent = label(d) + " · " + d.views.length + (d.views.length >= d.limit ? " newest" : "") + " · updated " + new Date(d.generatedAt).toLocaleTimeString();
  if (!d.views.length) { el.append(E("p", { cls: "empty", text: "No views yet." })); return; }
  const head = [E("th", { text: "When" }), E("th", { text: "Link" }), E("th", { text: "Browser" }), E("th", { text: "Device" }), E("th", { text: "Country" }), E("th", { text: "From" }),
    E("th", { cls: "n", text: "Total" }), E("th", { cls: "n", text: "Reached" })];
  for (let i = 1; i <= n; i++) head.push(E("th", { cls: "n", text: String(i), title: "Time on slide " + i }));
  head.push(E("th", { text: "Order of slides" }));
  const rows = d.views.map((v) => {
    const max = Math.max(1, ...v.ms);
    const cells = [
      E("td", { text: when(v.at), title: v.at + " → " + v.lastAt }),
      E("td", {}, [v.link || "direct link", v.linkDisabled ? E("span", { cls: "pill off", text: "disabled" }) : null]),
      E("td", {}, [v.browser || "–", v.visits > 1 ? E("span", { cls: "pill", text: "visit " + v.visit + " of " + v.visits }) : null, v.owner ? E("span", { cls: "pill ours", text: "ours" }) : null]),
      E("td", {}, [v.device || "–", v.fullscreen ? E("span", { cls: "pill", text: "full screen" }) : null, v.download ? E("span", { cls: "pill", text: "PDF" }) : null]),
      E("td", { text: v.country || "–" }), E("td", { text: v.referrer || "–" }),
      E("td", { cls: "n", text: dur(v.totalMs) }), E("td", { cls: "n", text: v.maxSlide + " / " + n })];
    v.ms.forEach((ms, i) => { const b = E("b"); b.style.width = Math.round(100 * ms / max) + "%";
      cells.push(E("td", { cls: "ms" + (ms ? "" : " z"), title: "Slide " + (i + 1) + ": " + ms.toLocaleString() + " ms" }, [ms ? dur(ms) : "–", ms ? b : null])); });
    cells.push(E("td", { cls: "path", text: v.path.join(" → ") }));
    return E("tr", {}, cells);
  });
  el.append(E("table", {}, [E("thead", {}, E("tr", {}, head)), E("tbody", {}, rows)]));
}
$("filter").addEventListener("change", (e) => { link = e.target.value; save(); load(); });
$("own").addEventListener("change", (e) => { own = e.target.checked; save(); load(); });

async function load() {
  try {
    const r = await fetch("/admin/api/deck?link=" + encodeURIComponent(link) + (own ? "&own=1" : ""), { cache: "no-store", credentials: "same-origin" });
    if (r.status === 401) { location.reload(); return; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    data = await r.json();
    renderFilter(data); renderMe(); renderLinks(data); renderAgg(data); renderViews(data);
    $("sub").textContent = (own ? "including" : "without") + " our own views";
  } catch (e) { $("sub").textContent = "update failed (" + e.message + ")"; }
}
renderMe();
load();
setInterval(() => { if (!document.hidden && !document.activeElement.matches("input[type=text]")) load(); }, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
})();`;
