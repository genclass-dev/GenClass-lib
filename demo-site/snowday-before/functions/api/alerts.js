// POST /api/alerts {email, count}  Subscribes and answers the new count, 300 ms later. No idempotency key, so a double
// click subscribes twice. Stateless: the page sends the count it has.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function onRequest({ request }) {
  if (request.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const body = await request.json().catch(() => ({}));
  await wait(300);
  return Response.json({ count: (Number(body.count) || 0) + 1 }, { headers: { "cache-control": "no-store" } });
}
