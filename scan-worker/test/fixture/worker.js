// genclass-scan-fixture: a page with known problems for the scanner's end-to-end runs (scan-worker/README.md).
// GET / is the page; GET /api/search?q= answers after 150 ms; everything else is 404 (the scanner answers POSTs itself,
// so /api/subscribe is never reached by it).
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Scanner test page</title>
<link rel="stylesheet" href="/missing.css">
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1d2433;background:#fff}
main{max-width:860px;margin:0 auto;padding:24px 16px}
.fine{color:#f6f6f6}
.wide{width:640px;background:#eef2f7;padding:12px}
.cover-wrap{position:relative;display:inline-block}
.cover{position:absolute;inset:-6px;background:rgba(255,255,255,0)}
#results li{font-family:ui-monospace,monospace}
form{margin-top:20px;display:flex;gap:8px}
button{font:inherit;padding:8px 16px}
</style></head>
<body><main>
<h1>Scanner test page</h1>
<p>Every problem on this page is deliberate. It exists to test the GenClass page check.</p>
<p class="fine">This sentence is nearly white on white.</p>
<p><span class="total">Total: NaN</span></p>
<img src="/missing-hero.png" alt="Hero image" width="320" height="120">
<div class="wide">This box is 640 px wide, wider than a phone.</div>
<p class="cover-wrap"><a href="/pricing">Pricing</a><span class="cover"></span></p>
<label>Search <input type="search" id="q" placeholder="Search cities" autocomplete="off"></label>
<ul id="results"></ul>
<form id="news" method="post" action="/api/subscribe">
  <input type="email" name="email" required placeholder="you@example.com">
  <button type="submit">Subscribe</button>
</form>
<p id="status"></p>
</main>
<script>
const q = document.getElementById("q"), out = document.getElementById("results");
q.addEventListener("input", async () => {
  const res = await fetch("/api/search?q=" + encodeURIComponent(q.value));
  const data = await res.json();
  out.textContent = "";
  for (const r of data.results) { const li = document.createElement("li"); li.textContent = r; out.appendChild(li); }
});
document.getElementById("news").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e.target.email.value }) });
  document.getElementById("status").textContent = res.ok ? "Subscribed." : "Failed.";
});
</script>
</body></html>`;
const CITIES = ["Amsterdam", "Abu Dhabi", "Abuja", "Accra", "Addis Ababa", "Adelaide", "Abbotsford", "Aberdeen", "Abidjan"];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      await new Promise((r) => setTimeout(r, 150));
      return Response.json({ q, results: CITIES.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 5) }, { headers: { "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
};
