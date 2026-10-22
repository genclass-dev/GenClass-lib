// The Terrible Vibe Coder on Cloudflare: the same API as server.mjs, but every visitor gets their own network switch,
// orders and note (a Durable Object per visitor, keyed by a cookie), so one visitor's train never slows another's
// Wi-Fi. public/ is served as static assets; GenClass is served from /genclass/ (packages/runtime/dist, copied there
// by deploy.sh). Deploy: examples/terrible-vibe-coder/deploy.sh

import { DurableObject } from "cloudflare:workers";

const PRODUCTS = [
  "VibePods", "VibePods Pro", "Vibe Watch", "Vibe Watch Ultra", "Vibe Lamp", "Vibe Mug", "Vibe Hoodie", "Vibe Socks",
  "Vibe Keyboard", "Vibe Mouse", "Vibe Desk", "Vibe Chair", "Vibe Plant", "Vibe Candle", "Vibe Backpack", "Vibe Bottle",
];

/** 0..1 from a counter (FNV-1a), so a visitor's shuffle can be repeated. */
function rnd(k) {
  let h = 0x811c9dc5;
  for (const c of String(k)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** One visitor's shop: network switch, request counter, orders (last 200) and note. */
export class Visitor extends DurableObject {
  async load() {
    this.s ??= (await this.ctx.storage.get("s")) ?? { slow: false, n: 0, orders: [], note: { text: "", version: 0 }, next: 1 };
    return this.s;
  }
  async save() {
    await this.ctx.storage.put("s", this.s);
  }
  /** The latency of the next answer: 100-1500 ms in any order on the train, 40 ms on Wi-Fi. */
  async latency(min, max) {
    const s = await this.load();
    if (!s.slow) return 40;
    s.n++;
    await this.save();
    return Math.round(min + rnd(s.n) * (max - min));
  }
  async network(slow, seed) {
    const s = await this.load();
    s.slow = !!slow;
    s.n = Math.max(0, Math.min(1e6, Math.floor(Number(seed) || 0))) * 1000;
    await this.save();
    return { slow: s.slow };
  }
  async order(item, cart) {
    const s = await this.load();
    const order = { id: `ord_${s.next++}`, item: String(item ?? "").slice(0, 100), cart: String(cart ?? "").slice(0, 100) };
    s.orders = [...s.orders, order].slice(-200);
    await this.save();
    return { order, wait: s.slow ? 900 : 40 };
  }
  async saveNote(text) {
    const s = await this.load();
    s.note = { text: String(text ?? "").slice(0, 2000), version: s.note.version + 1 };
    await this.save();
    return { ...s.note };
  }
  async state(cart) {
    const s = await this.load();
    return { slow: s.slow, orders: cart ? s.orders.filter((o) => o.cart === cart) : s.orders, note: s.note };
  }
  async reset() {
    const s = await this.load();
    s.orders = [];
    s.note = { text: "", version: 0 };
    await this.save();
    return { ok: true };
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function body(req) {
  try {
    const t = await req.text();
    return t.length > 10_000 ? {} : t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}
const visitorOf = (req) => /(?:^|;\s*)vibe=([a-z0-9]{16,40})/.exec(req.headers.get("cookie") ?? "")?.[1] ?? null;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/" || p === "/index.html") {
      const page = await env.ASSETS.fetch(new URL("/", url)); // the assets binding answers "/" with index.html
      const html = (await page.text()).replaceAll("%GENCLASS_BASE%", "/genclass/");
      const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
      if (!visitorOf(req)) headers["set-cookie"] = `vibe=${crypto.randomUUID().replaceAll("-", "")}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`;
      return new Response(html, { headers });
    }
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    const id = visitorOf(req);
    if (!id) return json({ error: "reload the page" }, 400);
    const v = env.VISITOR.get(env.VISITOR.idFromName(id));
    if (p === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
      const items = q ? PRODUCTS.filter((x) => x.toLowerCase().includes(q)) : [];
      await wait(await v.latency(100, 1500));
      return json({ q, items });
    }
    if (p === "/api/orders" && req.method === "POST") {
      const b = await body(req);
      const { order, wait: ms } = await v.order(b.item, b.cart);
      await wait(ms);
      return json(order);
    }
    if (p === "/api/note" && req.method === "PUT") {
      const saved = await v.saveNote((await body(req)).text);
      await wait(await v.latency(100, 1500));
      return json(saved);
    }
    if (p === "/api/state") return json(await v.state(url.searchParams.get("cart")));
    if (p === "/api/network" && req.method === "POST") {
      const b = await body(req);
      return json(await v.network(b.slow, b.seed));
    }
    if (p === "/api/reset" && req.method === "POST") return json(await v.reset());
    return json({ error: "not found" }, 404);
  },
};
