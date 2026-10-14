// genclass-scan-fixture: a page with known problems for the scanner's end-to-end runs (scan-worker/README.md).
// GET / is the page; GET /api/search?q= answers after 150 ms; everything else is 404 (the scanner answers POSTs itself,
// so /api/subscribe is never reached by it). The visual problems are ones the GenClass visual checks measure: text at
// 1.08:1 (GenClass fixes its colour in guard mode), "$NaN", a 404 stylesheet, a 404 image, a box wider than a phone,
// and a link at the end of the page under a fixed bar. Variants, off by default:
//   /?leak=1     a closed menu left pointer-events: none on <body>, so the page ignores clicks (GenClass removes the
//                leaked inline declaration in guard mode); while it is there the contrast check cannot hit-test the text
// and two for the scanner's own safety checks:
//   /?blank=1    adds a bigger POST form with target=_blank first: the probe must skip it and use the subscribe form
//   /?standin=1  adds a price loaded by POST /api/price while the page loads, rendered from the answer: the scanner
//                answers that POST itself, so the report must say so and not score what follows from it
// and one for the deeper checks (scan-score/3):
//   /?deep=1     one deliberate problem per new check: zoom off (maximum-scale=1), text at 2.85:1, an image without alt,
//                a button with no name, 16 px tap targets side by side, 10 px body text, a 340 px box (fits at 390 px,
//                scrolls sideways at 360 and 320; the 640 px box is left out so the narrow widths can be judged), an
//                800 by 600 image (1.4 MB) shown at 80 by 60, an image without dimensions that arrives after 1.5 s and
//                pushes the page down, an uncaught TypeError, a console.error, a 404 script, and a script and an image
//                asked for over http
//   /?deep=1&slow=1  the late image arrives after 4.5 s instead (Largest Contentful Paint above 4 s)
// Every POST that does reach this worker is counted (GET /api/posts), so a run can show that none did.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Scanner test page</title>
<link rel="stylesheet" href="/missing.css">
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#1d2433;background:#fff;display:flex;flex-direction:column;min-height:100vh}
main{max-width:860px;margin:0 auto;padding:24px 16px;flex:1}
footer{max-width:860px;width:100%;margin:0 auto;padding:12px 16px;box-sizing:border-box}
.fine{color:#f6f6f6}
.wide{width:640px;background:#eef2f7;padding:12px}
.chatbar{position:fixed;left:0;right:0;bottom:0;height:56px;background:#1d2433;color:#fff;display:flex;align-items:center;padding:0 16px;pointer-events:auto}

#results li{font-family:ui-monospace,monospace}
form{margin-top:20px;display:flex;gap:8px}
button{font:inherit;padding:8px 16px}
</style></head>
<body><main>
<h1>Scanner test page</h1>
<p>Every problem on this page is deliberate. It exists to test the GenClass page check.</p>
<p class="fine">This sentence is nearly white on white.</p>
<p><span class="total">Total: $NaN</span></p>
<img src="/missing-hero.png" alt="Hero image" width="320" height="120">
<div class="wide">This box is 640 px wide, wider than a phone.</div>
<label>Search <input type="search" id="q" placeholder="Search cities" autocomplete="off"></label>
<ul id="results"></ul>
<form id="news" method="post" action="/api/subscribe">
  <input type="email" name="email" required placeholder="you@example.com">
  <button type="submit">Subscribe</button>
</form>
<p id="status"></p>
<!--VARIANTS-->
</main>
<footer><a href="/terms">Terms</a></footer>
<div class="chatbar">Questions? We answer within a day.</div>
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
const BLANK = `<form id="popup" method="post" action="/api/popup" target="_blank" style="margin-top:20px">
  <button type="submit" style="font-size:28px;padding:20px 60px">Open in a new window</button>
</form>`;
const LEAK = `<script>document.body.style.pointerEvents = "none";</script>`;
const STANDIN = `<p>Price: <span id="price">loading</span></p>
<script>fetch("/api/price", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  .then((r) => r.json()).then((j) => { document.getElementById("price").textContent = String(j.price * 1); });</script>`;
const DEEP_TOP = `<img src="/late.bmp?SLOW" alt="A banner that arrives late" style="display:block;width:100%">`;
const DEEP = `<p class="grey">This paragraph is grey on white at about 2.85 to 1, readable but below the 4.5 to 1 that WCAG asks for.</p>
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" width="40" height="40">
<button class="iconbtn" type="button"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="#1d2433"/></svg></button>
<nav class="tiny" aria-label="Pages"><a href="/one">1</a><a href="/two">2</a><a href="/three">3</a><a href="/four">4</a></nav>
<p class="small">This line of body text is set at ten pixels, which is too small to read on a phone without zooming in.</p>
<img src="/big.bmp" alt="Noise, drawn much smaller than the file" width="80" height="60">
<img src="http://HOST/pixel-http.png" alt="" width="1" height="1">
<script src="/missing-chunk.js"></script>
<script src="http://HOST/mixed.js"></script>
<script>console.error("fixture: the widget could not load its settings");</script>
<script>window.fixtureWidget.init();</script>`;
const DEEP_CSS = `.grey{color:#999}.iconbtn{border:0;background:none;padding:4px}.tiny a{display:inline-block;width:16px;height:16px;font-size:10px;line-height:16px;margin:0 2px;text-align:center;background:#eef2f7}
.small{font-size:10px}.wide{width:340px;box-sizing:border-box}`;
const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
/** A 24-bit BMP of seeded noise: it does not compress, so its transferred size is its real size. */
function bmp(w, h, seed) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b[0] = 0x42; b[1] = 0x4d;
  v.setUint32(2, size, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true);
  v.setInt32(18, w, true); v.setInt32(22, h, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, row * h, true);
  let s = seed >>> 0 || 1;
  for (let i = 54; i < size; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; b[i] = s & 0xff; }
  return b;
}
let posts = 0;
const CITIES = ["Amsterdam", "Abu Dhabi", "Abuja", "Accra", "Addis Ababa", "Adelaide", "Abbotsford", "Aberdeen", "Abidjan"];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      posts++;
      console.log(`POST reached the fixture: ${request.method} ${url.pathname} (${posts} in this isolate)`);
    }
    if (url.pathname === "/api/posts") return Response.json({ posts }, { headers: { "cache-control": "no-store" } });
    if (url.pathname === "/") {
      const deep = url.searchParams.get("deep") === "1";
      const extra = (url.searchParams.get("blank") === "1" ? BLANK : "") + (url.searchParams.get("standin") === "1" ? STANDIN : "") + (url.searchParams.get("leak") === "1" ? LEAK : "") + (deep ? DEEP.replaceAll("HOST", url.host) : "");
      let page = PAGE.replace("<!--VARIANTS-->", extra);
      if (deep) {
        page = page
          .replace('content="width=device-width, initial-scale=1"', 'content="width=device-width, initial-scale=1, maximum-scale=1"')
          .replace("</style>", `${DEEP_CSS}</style>`)
          .replace("<h1>Scanner test page</h1>", `${DEEP_TOP.replace("SLOW", url.searchParams.get("slow") === "1" ? "slow=1" : "")}<h1>Scanner test page</h1>`)
          .replace("This box is 640 px wide, wider than a phone.", "This box is 340 px wide: it fits a 390 px phone, not a 360 px one.");
      }
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
    }
    if (url.pathname === "/big.bmp") return new Response(bmp(800, 600, 7), { headers: { "content-type": "image/bmp", "cache-control": "no-store" } });
    if (url.pathname === "/late.bmp") {
      await new Promise((r) => setTimeout(r, url.searchParams.get("slow") === "1" ? 4500 : 1500));
      return new Response(bmp(600, 200, 11), { headers: { "content-type": "image/bmp", "cache-control": "no-store" } });
    }
    if (url.pathname === "/pixel-http.png") return new Response(PIXEL, { headers: { "content-type": "image/png" } });
    if (url.pathname === "/api/price") return Response.json({ price: 12 });
    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      await new Promise((r) => setTimeout(r, 150));
      return Response.json({ q, results: CITIES.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 5) }, { headers: { "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
};
