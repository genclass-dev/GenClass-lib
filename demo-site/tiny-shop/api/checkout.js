// POST /api/checkout  Always 500 after 400 ms: a failing endpoint.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  await wait(400);
  res.setHeader("cache-control", "no-store");
  res.status(500).json({ error: "payment service unavailable" });
}
