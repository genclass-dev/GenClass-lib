#!/usr/bin/env node
// Claude's Shop on your machine (no dependencies): http://localhost:4545 is the shop as it is,
// http://localhost:4545/genclass-on the same page with GenClass, which also connects to the GenClass MCP server
// (Claude Code) on this machine. GenClass is served from public/genclass/ (packages/runtime/dist; deploy.sh copies it
// there) and the network behaves like a phone on a train (slow, answers in any order) until POST /api/network {slow:false}.
//
//   node server.mjs        PORT changes the port

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { GENCLASS_ON, search } from "./catalog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "public");
const PORT = Number(process.env.PORT) || 4545;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm" };

let slow = true;
let n = 0;
let orders = [];
let note = { text: "", version: 0 };

function rnd(k) {
  let h = 0x811c9dc5;
  for (const c of String(k)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}
const latency = (min, max) => (slow ? Math.round(min + rnd(++n) * (max - min)) : 40);
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const body = (req) =>
  new Promise((r) => {
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
const later = (ms, fn) => setTimeout(fn, ms);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  if (p === "/api/search") return later(latency(100, 1500), () => send(res, 200, search(url.searchParams.get("q"))));
  if (p === "/api/orders" && req.method === "POST") {
    const b = await body(req);
    const order = { id: `ord_${orders.length + 1}`, item: String(b.item ?? ""), cart: String(b.cart ?? "") };
    orders.push(order);
    return later(slow ? 900 : 40, () => send(res, 200, order));
  }
  if (p === "/api/note" && req.method === "PUT") {
    note = { text: String((await body(req)).text ?? "").slice(0, 2000), version: note.version + 1 };
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
  if (p === "/" || p === "/index.html" || p === "/genclass-on") {
    const html = readFileSync(join(pub, "index.html"), "utf8").replace("<!--GENCLASS-->", p === "/genclass-on" ? GENCLASS_ON("/genclass/") : "");
    res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
    return res.end(html);
  }
  const file = normalize(join(pub, p));
  if (!file.startsWith(pub) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Claude's Shop: http://localhost:${PORT} (without GenClass) and http://localhost:${PORT}/genclass-on`);
});
