// Claude's Shop catalog and GenClass tag, shared by server.mjs (local) and worker.js (Cloudflare). `kind` picks the product drawing in
// public/shop.js; `tone` is the tile colour.

export const PRODUCTS = [
  { id: "lamp", name: "Brass Desk Lamp", price: 89, kind: "lamp", tone: "#f3e3c3" },
  { id: "mug", name: "Stoneware Mug", price: 24, kind: "mug", tone: "#e6d8cc" },
  { id: "headphones", name: "Over-ear Headphones", price: 129, kind: "headphones", tone: "#d5dde8" },
  { id: "notebook", name: "Linen Notebook", price: 18, kind: "notebook", tone: "#e4e1d3" },
  { id: "pot", name: "Ceramic Plant Pot", price: 32, kind: "plant", tone: "#d6e4d2" },
  { id: "keyboard", name: "Low-profile Keyboard", price: 109, kind: "keyboard", tone: "#dcd9e6" },
  { id: "bottle", name: "Steel Water Bottle", price: 28, kind: "bottle", tone: "#d3e3e3" },
  { id: "clock", name: "Oak Wall Clock", price: 64, kind: "clock", tone: "#eadccb" },
  { id: "tote", name: "Canvas Tote", price: 22, kind: "tote", tone: "#ece4d0" },
  { id: "candle", name: "Cedar Candle", price: 26, kind: "candle", tone: "#efd9cf" },
  { id: "chair", name: "Reading Chair", price: 340, kind: "chair", tone: "#e2d6cf" },
  { id: "throw", name: "Wool Throw", price: 96, kind: "throw", tone: "#dfe0d0" },
];

/** Products whose name contains q (all of them for an empty q). */
export function search(q) {
  const s = String(q ?? "").trim().toLowerCase().slice(0, 100);
  return { q: s, items: s ? PRODUCTS.filter((p) => p.name.toLowerCase().includes(s)) : PRODUCTS };
}

export const byId = (id) => PRODUCTS.find((p) => p.id === id) ?? null;

/** GenClass for "/genclass-on": the project's public token, guard mode at the eager profile, visual fixes on. */
export const GENCLASS_TOKEN = "gc_JwpFSIbVSI0OmysXBTNm6O";
export const GENCLASS_ON = (base) =>
  `<script src="${base}genclass.global.min.js" data-manual></script>
<script>window.SHOP_GENCLASS = true; GenClass.init({ token: "${GENCLASS_TOKEN}", mode: "guard", aggressiveness: "eager", visual: { on: true, fix: true, lowEnd: "full" }, model: { preload: "eager" } });</script>`;
