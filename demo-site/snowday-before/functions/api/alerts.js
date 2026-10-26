// POST /api/alerts {email}  Subscribes and answers the new subscription, 300 ms later. No idempotency key, so a double
// click makes two subscriptions (two emails every evening).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function onRequest({ request }) {
  if (request.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const body = await request.json().catch(() => ({}));
  await wait(300);
  return Response.json({ id: crypto.randomUUID().slice(0, 8), email: String(body.email ?? "") }, { headers: { "cache-control": "no-store" } });
}
