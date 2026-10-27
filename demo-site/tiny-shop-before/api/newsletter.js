// POST /api/newsletter {email, attempt}  Every third attempt fails with 503: a transient failure. Stateless: the page
// sends which attempt this is.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = typeof req.body === "object" && req.body ? req.body : {};
  await wait(250);
  res.setHeader("cache-control", "no-store");
  if ((Number(body.attempt) || 0) % 3 === 0) return res.status(503).json({ error: "try again" });
  res.status(200).json({ ok: true });
}
