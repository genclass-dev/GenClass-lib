// POST /api/cart {item, count}  Adds a line and answers the new count, 300 ms later. No idempotency key, so a double
// click adds twice. Stateless (a serverless function): the page sends the count it has.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = typeof req.body === "object" && req.body ? req.body : {};
  await wait(300);
  res.setHeader("cache-control", "no-store");
  res.status(200).json({ count: (Number(body.count) || 0) + 1, item: String(body.item ?? "?") });
}
