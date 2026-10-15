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
//                and, for scan-score/4: 16 header links before the main content and no skip link, two links with
//                outline: none (no visible focus), one of them "click here", a box 800 px wide from 700 px up (sideways
//                scrolling on a 768 px tablet), a 2.1 MB image (page weight; the images are BMP, an old format), a
//                stylesheet that answers after 2 s (a late first paint), a Google font without font-display, an unload
//                handler (deprecated), and a session cookie without Secure or HttpOnly. The page never sends
//                Strict-Transport-Security, a CSP, nosniff or X-Frame-Options, and has no description, link preview
//                tags or favicon.
//   /?deep=1&slow=1  the late image arrives after 4.5 s instead (Largest Contentful Paint above 4 s)
// and one for the model judge, with cases the measured checks abstain on (the background is a gradient or an image):
//   /?judge=1    a "Start free trial" link drawn as a white button with a white-to-near-white gradient, whose text is
//                dark in the light scheme and white in the dark scheme (white on white there); grey text over a busy
//                image that cannot be read; and, as controls, white bold text with a shadow over the same image under
//                a dark overlay, which can be read, and a paragraph coloured by a CSS variable defined nowhere, which
//                falls back to the inherited colour and reads normally (the visual checks report css-var-undefined only
//                when the text it affects becomes unreadable, so they leave it out too)
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
<script>window.fixtureWidget.init();</script>
<p class="more serif"><a class="nofocus" href="/docs">Read the guide</a>, or <a class="nofocus" href="/blog">click here</a> for the blog.</p>
<div class="tabletwide">This box is 800 px wide on screens 700 px and wider.</div>
<img src="/heavy.bmp" alt="More noise, drawn smaller than the file" width="200" height="140">
<script>window.addEventListener("unload", function () {});</script>`;
const DEEP_HEAD = `<link rel="stylesheet" href="/slow.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora">`;
const DEEP_NAV = `<header class="topnav">${["News", "Guides", "Pricing", "Docs", "Blog", "Careers", "Press", "Partners", "Events", "Status", "Security", "Legal", "Help", "Contact", "Sign in", "Sign up"].map((t, i) => `<a href="/nav${i + 1}">${t}</a>`).join("")}</header>`;
const DEEP_CSS = `.nofocus{outline:none}.serif{font-family:Lora,serif}.tabletwide{display:none}@media (min-width:700px){.tabletwide{display:block;width:800px;box-sizing:border-box;background:#eef2f7;padding:12px}}
.topnav{max-width:860px;margin:0 auto;padding:8px 16px;display:flex;flex-wrap:wrap;gap:4px 12px}.topnav a{display:inline-block;padding:6px 4px}
.grey{color:#999}.iconbtn{border:0;background:none;padding:4px}.tiny a{display:inline-block;width:16px;height:16px;font-size:10px;line-height:16px;margin:0 2px;text-align:center;background:#eef2f7}
.small{font-size:10px}.wide{width:340px;box-sizing:border-box}`;
const JUDGE = `<p class="varink">This sentence's colour is a CSS variable defined nowhere, so it falls back to the text colour around it and reads normally.</p>
<section class="dk"><p>Plans start at five dollars a month, billed yearly.</p><a class="darkbtn" href="/start">Start free trial</a></section>
<div class="busy"><p>Free shipping on every order over fifty dollars, all week long.</p></div>
<div class="calm"><p>Readable: white bold text over the same picture, under a dark overlay.</p></div>`;
const JUDGE_CSS = `.varink{color:var(--brand-ink)}.dk{margin-top:16px;padding:14px 16px;background:#f4f6fa;border-radius:8px}.dk p{margin:0}
.darkbtn{display:inline-block;margin-top:10px;padding:10px 18px;border-radius:6px;font-weight:600;text-decoration:none;color:#1d2433;background-image:linear-gradient(#ffffff,#f1f3f6)}
@media (prefers-color-scheme:dark){.dk{background:#141922;color:#e6e9ef}.darkbtn{color:#ffffff}}
.busy,.calm{margin-top:16px;padding:28px 16px;background:url(/busy.svg) center/cover}.busy p,.calm p{margin:0}
.busy p{color:#8a8a8a;font-size:15px}
.calm{background:linear-gradient(rgba(10,12,18,.62),rgba(10,12,18,.62)),url(/busy.svg) center/cover}.calm p{color:#fff;font-weight:700;font-size:17px;text-shadow:0 1px 2px #000}`;
/** A busy picture: seeded rectangles and circles in every hue, mid-light, so grey text over it cannot be read. */
function busySvg() {
  let s = 12345;
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const parts = [];
  for (let i = 0; i < 260; i++) {
    const fill = `hsl(${Math.round(r() * 360)},${Math.round(30 + r() * 50)}%,${Math.round(35 + r() * 40)}%)`;
    if (r() < 0.5) parts.push(`<rect x="${Math.round(r() * 800)}" y="${Math.round(r() * 300)}" width="${Math.round(10 + r() * 90)}" height="${Math.round(6 + r() * 50)}" fill="${fill}"/>`);
    else parts.push(`<circle cx="${Math.round(r() * 800)}" cy="${Math.round(r() * 300)}" r="${Math.round(4 + r() * 30)}" fill="${fill}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300" viewBox="0 0 800 300"><rect width="800" height="300" fill="#9a9a9a"/>${parts.join("")}</svg>`;
}
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
          .replace("This box is 640 px wide, wider than a phone.", "This box is 340 px wide: it fits a 390 px phone, not a 360 px one.")
          .replace('<link rel="stylesheet" href="/missing.css">', `<link rel="stylesheet" href="/missing.css">${DEEP_HEAD}`)
          .replace("<body><main>", `<body>${DEEP_NAV}<main>`);
      }
      if (url.searchParams.get("judge") === "1") {
        // near the top, so the cases are in the first screen, but after the faint sentence: put before it they push it
        // down under the fixed chat bar, where the visual checks rightly leave it out (covered), and the judge's second
        // look at a measured finding has nothing to work on
        page = page.replace("</style>", `${JUDGE_CSS}</style>`).replace("nearly white on white.</p>", `nearly white on white.</p>\n${JUDGE}`);
      }
      const headers = { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" };
      if (deep) headers["set-cookie"] = "sessionid=fixture; Path=/";
      return new Response(page, { headers });
    }
    if (url.pathname === "/busy.svg") return new Response(busySvg(), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
    if (url.pathname === "/heavy.bmp") return new Response(bmp(1000, 700, 13), { headers: { "content-type": "image/bmp", "cache-control": "no-store" } });
    if (url.pathname === "/slow.css") {
      await new Promise((r) => setTimeout(r, 2000));
      return new Response("main{border-top:4px solid #eef2f7}", { headers: { "content-type": "text/css", "cache-control": "no-store" } });
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
