#!/usr/bin/env node
// The Terrible Vibe Coder: the backend of a small shop (VibeShop) that an AI wrote in four minutes, and a network that
// behaves like a phone on a train when you ask it to. No dependencies.
//
//   node examples/terrible-vibe-coder/server.mjs          then open http://localhost:4545
//
// GenClass comes from jsDelivr (@genclass/runtime@0.3.0-beta.1). GENCLASS_LOCAL=1 serves packages/runtime/dist
// instead (after `npm run build -w @genclass/runtime`). PORT changes the port.
//
// API
//   GET  /api/search?q=...         products matching q            (slow network: 100-1500 ms, any order)
//   POST /api/orders {item, cart}  places (and "charges") an order (slow network: 900 ms)
//   PUT  /api/note {text}          saves the note, answers the saved copy (slow network: 100-1500 ms, any order)
//   GET  /api/state?cart=...       what the server holds: orders for that cart, the saved note
//   POST /api/network {slow, seed} switch the network: slow and shuffled, or fast and in order (seed: another shuffle)
//   POST /api/reset                forget orders and the note

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "public");
const localDist = resolve(here, "../../packages/runtime/dist");
const PORT = Number(process.env.PORT) || 4545;
const VERSION = "0.3.0-beta.1";
const LOCAL = process.env.GENCLASS_LOCAL === "1";
const GENCLASS_BASE = LOCAL ? "/genclass/" : `https://cdn.jsdelivr.net/npm/@genclass/runtime@${VERSION}/dist/`;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json", ".json": "application/json", ".svg": "image/svg+xml" };

const PRODUCTS = [
  "VibePods", "VibePods Pro", "Vibe Watch", "Vibe Watch Ultra", "Vibe Lamp", "Vibe Mug", "Vibe Hoodie", "Vibe Socks",
  "Vibe Keyboard", "Vibe Mouse", "Vibe Desk", "Vibe Chair", "Vibe Plant", "Vibe Candle", "Vibe Backpack", "Vibe Bottle",
];

let slow = false;
let n = 0; // request counter: the "random" latency is a hash of it, so a run can be repeated
let orders = []; // { id, item, cart }
let note = { text: "", version: 0 };

/** 0..1 from a counter (FNV-1a), so the shuffle is deterministic per server start. */
function rnd(k) {
  let h = 0x811c9dc5;
  for (const c of String(k)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}
const latency = (min, max) => (slow ? Math.round(min + rnd(++n) * (max - min)) : 40);

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function body(req) {
  return new Promise((r) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        r(s ? JSON.parse(s) : {});
      } catch {
        r({});
      }
    });
  });
}

const later = (ms, fn) => setTimeout(fn, ms);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  if (p === "/api/search") {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const items = q ? PRODUCTS.filter((x) => x.toLowerCase().includes(q)) : [];
    return later(latency(100, 1500), () => send(res, 200, { q, items }));
  }
  if (p === "/api/orders" && req.method === "POST") {
    const b = await body(req);
    const order = { id: `ord_${orders.length + 1}`, item: String(b.item ?? ""), cart: String(b.cart ?? "") };
    orders.push(order);
    return later(slow ? 900 : 40, () => send(res, 200, order));
  }
  if (p === "/api/note" && req.method === "PUT") {
    const b = await body(req);
    note = { text: String(b.text ?? "").slice(0, 2000), version: note.version + 1 };
    const saved = { ...note };
    return later(latency(100, 1500), () => send(res, 200, saved));
  }
  if (p === "/api/state") {
    const cart = url.searchParams.get("cart");
    return send(res, 200, { slow, orders: cart ? orders.filter((o) => o.cart === cart) : orders, note });
  }
  if (p === "/api/network" && req.method === "POST") {
    const b = await body(req);
    slow = !!b.slow;
    n = Math.max(0, Math.floor(Number(b.seed) || 0)) * 1000;
    return send(res, 200, { slow });
  }
  if (p === "/api/reset" && req.method === "POST") {
    orders = [];
    note = { text: "", version: 0 };
    return send(res, 200, { ok: true });
  }
  // static files: the shop, and GenClass from the local build with GENCLASS_LOCAL=1
  let file;
  if (LOCAL && p.startsWith("/genclass/")) file = normalize(join(localDist, p.slice("/genclass/".length)));
  else file = normalize(join(pub, p === "/" ? "index.html" : p));
  if (!(file.startsWith(pub) || (LOCAL && file.startsWith(localDist))) || !existsSync(file) || statSync(file).isDirectory()) return send(res, 404, "not found", "text/plain");
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  let data = readFileSync(file);
  if (type.startsWith("text/html")) data = Buffer.from(data.toString("utf8").replaceAll("%GENCLASS_BASE%", GENCLASS_BASE));
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`The Terrible Vibe Coder's shop: http://localhost:${PORT}`);
  console.log(`GenClass from ${LOCAL ? "packages/runtime/dist (GENCLASS_LOCAL=1)" : GENCLASS_BASE}`);
});
