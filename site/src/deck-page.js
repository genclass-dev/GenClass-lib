// genclass.dev/admin/deck: the pitch deck's views, one row per page load with the time on each slide. Served behind the
// admin session (src/admin.js) under its strict CSP; the script is /admin/deck.js and only ever sets textContent.

export const DECK_ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Pitch deck views</title><link rel="icon" href="data:,">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#F5F8FB;color:#0E1F4D;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:20px}
a{color:inherit}main{max-width:1400px;margin:0 auto;display:grid;gap:14px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px}h1{font-size:20px}
header nav{margin-left:auto;display:flex;gap:12px;font-size:13px}
.sub{color:#5A6684;font-size:13px}
.card{background:#fff;border:1px solid #DFE4EC;border-radius:12px;padding:14px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:980px}
th{text-align:left;font-weight:600;font-size:11.5px;color:#5A6684;text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;border-bottom:1px solid #DFE4EC;white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid #EEF1F5;vertical-align:middle;white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td.ms{font-variant-numeric:tabular-nums;color:#3D4B6B;font-size:12px;text-align:right}
td.ms b{display:block;height:4px;background:#0E1F4D;border-radius:2px;margin-top:2px;margin-left:auto;opacity:.75}
td.ms.z{color:#C6CEDB}
.pill{display:inline-block;font-size:11px;border-radius:999px;padding:0 7px;background:#EEF1F5;color:#3D4B6B;margin-left:4px}
.path{color:#5A6684;font-size:12px;white-space:normal;min-width:120px}
.empty{color:#5A6684;padding:10px}
</style></head><body><main>
<header><h1>Pitch deck views</h1><span class="sub" id="sub">loading…</span>
<nav><a href="/admin">Dashboard</a><a href="/pitch-deck" target="_blank" rel="noopener">Open the deck</a><a href="/admin/logout">Sign out</a></nav></header>
<p class="sub">One row per page load. Slide times count only while the deck was on screen in a visible tab with the window focused. Browser: a random id kept in that browser, so repeat visits show as visit 2, 3… Times update every 10 s while someone reads.</p>
<div class="card" id="views"></div>
</main><script src="/admin/deck.js" defer></script></body></html>`;

export const DECK_ADMIN_JS = String.raw`(() => {
const $ = (id) => document.getElementById(id);
const E = (tag, attrs, kids) => { const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === "text") e.textContent = v; else if (k === "cls") e.className = v; else if (v !== undefined && v !== null) e.setAttribute(k, v); }
  for (const c of [].concat(kids || [])) if (c !== null && c !== undefined) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e; };
const dur = (ms) => { if (!ms) return "0 s"; const s = ms / 1000; if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + " s";
  const m = Math.floor(s / 60), r = Math.round(s % 60); if (m < 60) return m + " m " + String(r).padStart(2, "0") + " s";
  return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " m"; };
const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "–" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };

function render(d) {
  const n = d.slides, el = $("views");
  $("sub").textContent = d.views.length + " view" + (d.views.length === 1 ? "" : "s") + (d.views.length >= d.limit ? " (latest " + d.limit + ")" : "") + " · updated " + new Date(d.generatedAt).toLocaleTimeString();
  el.replaceChildren();
  if (!d.views.length) { el.append(E("p", { cls: "empty", text: "No views yet." })); return; }
  const head = [E("th", { text: "When" }), E("th", { text: "Link" }), E("th", { text: "Browser" }), E("th", { text: "Device" }), E("th", { text: "Country" }), E("th", { text: "From" }),
    E("th", { cls: "n", text: "Total" }), E("th", { cls: "n", text: "Reached" })];
  for (let i = 1; i <= n; i++) head.push(E("th", { cls: "n", text: String(i), title: "Time on slide " + i }));
  head.push(E("th", { text: "Order of slides" }));
  const rows = d.views.map((v) => {
    const max = Math.max(1, ...v.ms);
    const cells = [
      E("td", { text: when(v.at), title: v.at + " → " + v.lastAt }),
      E("td", { text: v.link || "direct link" }),
      E("td", {}, [v.browser || "–", v.visits > 1 ? E("span", { cls: "pill", text: "visit " + v.visit + " of " + v.visits }) : null]),
      E("td", {}, [v.device || "–", v.fullscreen ? E("span", { cls: "pill", text: "full screen" }) : null, v.download ? E("span", { cls: "pill", text: "PDF" }) : null]),
      E("td", { text: v.country || "–" }),
      E("td", { text: v.referrer || "–" }),
      E("td", { cls: "n", text: dur(v.totalMs) }),
      E("td", { cls: "n", text: v.maxSlide + " / " + n }),
    ];
    v.ms.forEach((ms, i) => { const b = E("b"); b.style.width = Math.round(100 * ms / max) + "%";
      cells.push(E("td", { cls: "ms" + (ms ? "" : " z"), title: "Slide " + (i + 1) + ": " + ms.toLocaleString() + " ms" }, [ms ? dur(ms) : "–", ms ? b : null])); });
    cells.push(E("td", { cls: "path", text: v.path.join(" → ") }));
    return E("tr", {}, cells);
  });
  el.append(E("table", {}, [E("thead", {}, E("tr", {}, head)), E("tbody", {}, rows)]));
}
async function load() {
  try {
    const r = await fetch("/admin/api/deck", { cache: "no-store", credentials: "same-origin" });
    if (r.status === 401) { location.reload(); return; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    render(await r.json());
  } catch (e) { $("sub").textContent = "update failed (" + e.message + ")"; }
}
load();
setInterval(() => { if (!document.hidden) load(); }, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
})();`;
