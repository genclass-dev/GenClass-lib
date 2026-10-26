// GET /api/roads  Road conditions, 3.5 s later: a slow endpoint.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function onRequest() {
  await wait(3500);
  return Response.json({ roads: [{ road: "QEW", status: "snow covered" }, { road: "Highway 403", status: "wet" }, { road: "Dundas St", status: "plowed" }] }, { headers: { "cache-control": "no-store" } });
}
