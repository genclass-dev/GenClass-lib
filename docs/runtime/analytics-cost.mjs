// Byte cost of the genclass-analytics/1 batches proposed in docs/runtime/ANALYTICS.md §6 (the schema as revised after
// the 2026-10-13 review: mode, sample, cand and late added, no `to`): a deterministic synthetic workload serialised in
// the proposed schema. It does not run the runtime; the v1 test (test/analytics.test.ts, "an
// hour of actions") replaces these estimates with measured numbers. Bodies are uncompressed JSON, as the transport
// sends them (text/plain, no gzip). Run: node docs/runtime/analytics-cost.mjs
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const ROUTES = ["/", "/products", "/products/:id", "/cart", "/checkout", "/account"];
// 8 element keys per route (key format: ANALYTICS.md §3)
const ELS = {
  "/": ["link[/products]@header", "link[/cart]@header", "link[/account]@header", "button#hero-cta@main", "link[/products/:id]@main", "button@main~3fa2c1", "link[twitter.com]@footer", "button#newsletter@form#newsletter"],
  "/products": ["link[/products/:id]@main", "button#filter-open@main", "checkbox#in-stock@form#filters", "select#sort@main", "button@main~9c01d2", "link[/cart]@header", "input(search)#q@search", "button#load-more@main"],
  "/products/:id": ["button#add-to-cart@main", "button#qty-inc@main", "button#qty-dec@main", "tab#reviews@main", "tab#details@main", "img@main~11aa02", "link[/cart]@header", "button@dialog~2b3c4d"],
  "/cart": ["button#checkout@main", "button#remove-item@main", "input(number)#qty@main", "input(text)#coupon@form#coupon", "button#apply-coupon@form#coupon", "link[/products]@main", "link[/cart]@header", "div@main~77e0f1"],
  "/checkout": ["button#place-order@form#checkout", "input(email)#email@form#checkout", "input(text)#name@form#checkout", "select#country@form#checkout", "checkbox#gift@form#checkout", "radio#ship-express@form#checkout", "link[/cart]@main", "button@dialog~5e6f70"],
  "/account": ["button#save@form#profile", "tab#orders@main", "tab#settings@main", "link[/orders/:id]@main", "button#sign-out@header", "switch#emails@form#profile", "input(text)#display-name@form#profile", "button@main~0a0b0c"],
};
// the request each of these buttons starts
const SIGS = {
  "button#add-to-cart@main": "POST /api/cart",
  "button#place-order@form#checkout": "POST /api/orders",
  "button#checkout@main": "GET /api/cart",
  "button#apply-coupon@form#coupon": "POST /api/coupons/validate",
  "button#save@form#profile": "PATCH /api/me",
  "button#load-more@main": "GET /api/products",
  "button#qty-inc@main": "PATCH /api/cart/:id",
  "button#qty-dec@main": "PATCH /api/cart/:id",
};
const env = (seq, sent) => ({ schema: "genclass-analytics/1", token: "gc_" + "a".repeat(22), pid: "f".repeat(24), seq, sent, runtime: "0.4.0", mode: "observe", sample: 1, consent: "granted", text: false });
// candidate roles for dead clicks (§2.1): every key here whose role is button, link, tab, menuitem, option, switch
const CANDIDATE = (key) => /^(button|link|tab|menuitem|option|switch)\b/.test(key);

/** One tab open for an hour: `perMin` clicks a minute, a route change every `viewEveryMin` minutes, a batch a minute. */
function hour(perMin, viewEveryMin) {
  const batches = [];
  let route = "/";
  let v = 0;
  let from = "(entry)";
  let opened = true;
  let tfiSent = false;
  let marks = 0;
  for (let min = 0; min < 60; min++) {
    const page = { v, route };
    if (opened) {
      page.from = from;
      opened = false;
    }
    const els = {};
    for (let k = 0; k < perMin; k++) {
      const el = pick(ELS[route]);
      const e = (els[el] ??= { n: 0 });
      e.n++;
      if (CANDIDATE(el)) e.cand = (e.cand ?? 0) + 1;
      if (!tfiSent) {
        page.tfi = Math.floor(rnd() * 4);
        tfiSent = true;
      }
      const sig = SIGS[el];
      if (sig) {
        e.req = (e.req ?? 0) + 1;
        e.settle ??= [0, 0, 0, 0, 0, 0];
        e.settle[1 + Math.floor(rnd() * 3)]++;
        const r = ((e.reqs ??= {})[sig] ??= [0, 0, 0, 0, 0]);
        r[0]++;
        r[rnd() < 0.95 ? 1 : 3]++;
      } else if (CANDIDATE(el) && rnd() < 0.03) e.dead = (e.dead ?? 0) + 1;
      else if (CANDIDATE(el) && rnd() < 0.02) e.late = (e.late ?? 0) + 1;
      if (CANDIDATE(el) && rnd() < 0.01) e.rage = (e.rage ?? 0) + 1;
    }
    if (Object.keys(els).length) page.els = els;
    const reach = Math.min(4, marks + (rnd() < 0.5 ? 1 : 0));
    if (reach > marks) {
      page.scroll = Array.from({ length: reach - marks }, (_, i) => marks + i + 1);
      marks = reach;
    }
    if ((min + 1) % viewEveryMin === 0 && min < 59) {
      const next = pick(ROUTES.filter((r) => r !== route));
      from = route;
      route = next;
      v++;
      opened = true;
      tfiSent = false;
      marks = 0;
    }
    batches.push(JSON.stringify({ ...env(min, (min + 1) * 60_000), pages: [page] }));
  }
  return batches;
}

for (const [perMin, every] of [
  [6, 3],
  [60, 3],
  [60, 1],
]) {
  const b = hour(perMin, every);
  const bytes = b.reduce((n, s) => n + s.length, 0);
  const max = Math.max(...b.map((s) => s.length));
  console.log(`${perMin} clicks/min, a route change every ${every} min, 1 h: ${b.length} batches, ${(bytes / 1024).toFixed(1)} KB (${Math.round(bytes / b.length)} B per batch on average, largest ${max} B)`);
}
const short = JSON.stringify({
  ...env(0, 45_000),
  pages: [
    {
      v: 0,
      route: "/products/:id",
      from: "(entry)",
      tfi: 1,
      scroll: [1, 2],
      els: {
        "button#add-to-cart@main": { n: 1, cand: 1, req: 1, settle: [0, 0, 1, 0, 0, 0], reqs: { "POST /api/cart": [1, 1, 0, 0, 0] } },
        "tab#reviews@main": { n: 2, cand: 2 },
        "img@main~11aa02": { n: 1 },
        "link[/cart]@header": { n: 1 },
      },
    },
  ],
});
console.log(`a short page view (45 s, 5 clicks, one batch on pagehide): ${short.length} B`);
console.log(`the envelope alone: ${JSON.stringify({ ...env(0, 0), pages: [] }).length} B`);
console.log(`ceiling from the timer at flushMs 60 s: 60 batches an hour at the 4 KB batch cap = ${((60 * 4096) / 1024).toFixed(0)} KB, plus 4 KB per hide, pagehide or flush() batch`);
const cfg = "GET /api/v1/analytics/config?token=gc_" + "a".repeat(22);
console.log(`config request line: ${cfg.length} B; its reply body: ${JSON.stringify({ on: true, consent: "required" }).length} B`);
