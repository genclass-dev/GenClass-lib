// GET /api/search?q=  A one-letter query answers slowly (1200 ms; 200 ms for longer ones), so typing fast makes the
// first response arrive after the later ones: the last one to arrive wins, and it is the wrong one.
const PRODUCTS = ["React handbook", "Reactive mug", "Reading lamp", "Real wood desk", "Red notebook", "Rust in action", "Retro keyboard", "Ruler, 30 cm"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const q = String(req.query.q ?? "").toLowerCase();
  await wait(q.length <= 1 ? 1200 : 200);
  res.setHeader("cache-control", "no-store");
  res.status(200).json({ q, results: PRODUCTS.filter((p) => p.toLowerCase().includes(q)) });
}
