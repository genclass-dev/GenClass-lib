// POST /api/vote {choice}  Records one vote in the community poll and answers it with its own id, 300 ms later. No
// idempotency key, so a double click votes twice.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function onRequest({ request }) {
  if (request.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const body = await request.json().catch(() => ({}));
  await wait(300);
  return Response.json({ id: crypto.randomUUID().slice(0, 8), choice: body.choice === "no" ? "no" : "yes" }, { headers: { "cache-control": "no-store" } });
}
