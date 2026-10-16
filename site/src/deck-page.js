// genclass.dev/admin/deck: the pitch deck's share links, per-slide aggregates and views. Served behind the admin session
// (src/admin.js) under its strict CSP; the script is /admin/deck.js and only ever sets textContent. "This browser is
// ours" uses the same localStorage keys as the viewer (deck.viewer, deck.owner): both pages are on genclass.dev.

export const DECK_ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Pitch deck views</title><link rel="icon" href="data:,">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#F5F8FB;color:#0E1F4D;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:20px}
a{color:inherit}main{max-width:1400px;margin:0 auto;display:grid;gap:14px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px}h1{font-size:20px}
header nav{margin-left:auto;display:flex;gap:12px;font-size:13px}
h2{font-size:15px;margin-bottom:10px;display:flex;flex-wrap:wrap;align-items:baseline;gap:10px}h2 small{font-weight:400;color:#5A6684;font-size:12.5px}
.sub{color:#5A6684;font-size:13px}
.card{background:#fff;border:1px solid #DFE4EC;border-radius:12px;padding:14px}
.scroll{overflow:auto}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
button,input,select{font:inherit;color:inherit}
button,.btn{border:1px solid #C6CEDB;background:#fff;border-radius:8px;padding:4px 10px;font-size:13px;cursor:pointer}
button:hover{border-color:#0E1F4D}button.primary{background:#0E1F4D;color:#fff;border-color:#0E1F4D}
input[type=text]{border:1px solid #C6CEDB;border-radius:8px;padding:5px 10px;min-width:240px}
select{border:1px solid #C6CEDB;border-radius:8px;padding:4px 8px;background:#fff}
:focus-visible{outline:2px solid #14B86A;outline-offset:2px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;font-size:11.5px;color:#5A6684;text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;border-bottom:1px solid #DFE4EC;white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid #EEF1F5;vertical-align:middle;white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td.ms{font-variant-numeric:tabular-nums;color:#3D4B6B;font-size:12px;text-align:right}
td.ms b{display:block;height:4px;background:#0E1F4D;border-radius:2px;margin-top:2px;margin-left:auto;opacity:.75}
td.z{color:#C6CEDB}
.views table{min-width:1100px}.links table{min-width:1000px}
.pill{display:inline-block;font-size:11px;border-radius:999px;padding:0 7px;background:#EEF1F5;color:#3D4B6B;margin-left:4px}
.pill.off{background:#FDE6E0;color:#C42A12}.pill.ours{background:#FFF3D6;color:#7A5200}
.path{color:#5A6684;font-size:12px;white-space:normal;min-width:120px}
code{font:12px ui-monospace,Menlo,monospace;color:#3D4B6B}
.empty{color:#5A6684;padding:10px}
.meter{display:inline-block;vertical-align:middle;width:120px;height:8px;background:#EEF1F5;border-radius:4px;overflow:hidden;margin-left:8px}
.meter i{display:block;height:100%;background:#0E1F4D}.meter.red i{background:#F0451C}
.spark{display:inline-flex;align-items:flex-end;gap:2px;height:22px;vertical-align:middle}
.spark i{display:block;width:7px;background:#0E1F4D;border-radius:1px;min-height:1px;opacity:.8}
.err{color:#C42A12;font-size:13px}
</style></head><body><main>
<header><h1>Pitch deck</h1><span class="sub" id="sub">loading…</span>
<nav><a href="/admin">Dashboard</a><a href="/pitch-deck" target="_blank" rel="noopener">Open the deck</a><a href="/admin/logout">Sign out</a></nav></header>
<section class="card"><h2>This browser</h2><div class="row"><span id="me-t" class="sub"></span><button type="button" id="me-b"></button></div></section>
<section class="card links"><h2>Share links <small>genclass.dev/pitch-deck?k=… The token is random and says nothing about the name. A disabled link's new views count as the direct link (the deck stays public).</small></h2>
<form class="row" id="new"><input type="text" id="new-name" maxlength="80" placeholder="Name, e.g. a fund or a person" aria-label="New link name" required><button class="primary" type="submit">Create link</button><span class="err" id="new-err" role="alert"></span></form>
<div class="scroll" id="links" style="margin-top:10px"></div></section>
<section class="card"><h2>Slides <small id="agg-sub"></small></h2><div class="scroll" id="agg"></div></section>
<section class="card views"><h2>Views <small id="views-sub"></small></h2>
<div class="row" style="margin-bottom:8px"><label class="sub" for="filter">Link</label><select id="filter"></select>
<label class="sub"><input type="checkbox" id="own"> Show our own views</label></div>
<p class="sub" style="margin-bottom:8px">One row per page load. Slide times count only while the deck was on screen in a visible tab with the window focused. Browser: a random id kept in that browser, so repeat visits show as visit 2, 3…</p>
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
