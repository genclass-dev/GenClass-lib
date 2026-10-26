// Tiny Shop's API: a small Node server with the timing and failures a real backend has on a bad day, on purpose.
// No dependencies. Started by the walkthrough (and by `npm run api`); Vite proxies /api to it.
//
//   GET  /api/search?q=   results for q. A one-letter query answers SLOWLY (1200 ms; 200 ms after), so typing fast
//                         makes the first response arrive after the later ones: a stale response wins.
//   POST /api/cart        adds a line, 300 ms, no idempotency key: a double click adds twice.
//   POST /api/checkout    always 500 after 400 ms: a failing endpoint.
//   GET  /api/reviews     3.5 s: a slow endpoint.
//   GET  /api/profile     an object without the fields the page reads: a TypeError in the click handler.
//   POST /api/newsletter  every third call fails with 503: a transient failure.
import { createServer } from "node:http";

const PORT = Number(process.env.API_PORT || 8788);
const PRODUCTS = ["React handbook", "Reactive mug", "Reading lamp", "Real wood desk", "Red notebook", "Rust in action", "Retro keyboard", "Ruler, 30 cm"];
let cart = [];
let newsletterCalls = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { let t = ""; req.on("data", (c) => (t += c)); req.on("end", () => r(t)); });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/search") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    await wait(q.length <= 1 ? 1200 : 200);
    return json(res, 200, { q, results: PRODUCTS.filter((p) => p.toLowerCase().includes(q)) });
  }
  if (req.method === "POST" && path === "/api/cart") {
    const body = JSON.parse((await readBody(req)) || "{}");
    await wait(300);
    cart.push(body.item || "?");
    return json(res, 200, { count: cart.length, items: cart });
  }
  if (req.method === "POST" && path === "/api/checkout") {
    await readBody(req);
    await wait(400);
    return json(res, 500, { error: "payment service unavailable" });
  }
  if (req.method === "GET" && path === "/api/reviews") {
    await wait(3500);
    return json(res, 200, { reviews: [{ who: "A. Reader", text: "Great lamp." }, { who: "B. Typist", text: "Clicky keys." }] });
  }
  if (req.method === "GET" && path === "/api/profile") {
    await wait(150);
    return json(res, 200, { id: 7 }); // no `name`, no `address`: the page reads profile.address.city
  }
  if (req.method === "POST" && path === "/api/newsletter") {
    await readBody(req);
    newsletterCalls++;
    await wait(250);
    if (newsletterCalls % 3 === 0) return json(res, 503, { error: "try again" });
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && path === "/api/reset") {
    cart = [];
    newsletterCalls = 0;
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`tiny-shop api on http://127.0.0.1:${PORT}`));
