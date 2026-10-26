// GET /api/boards?q=  School boards matching q. A one-letter query answers slowly (1200 ms; 200 ms for longer ones),
// so typing fast makes the first response arrive after the later ones: the last one to arrive wins, and it is wrong.
const BOARDS = ["Halton DSB", "Halton Catholic DSB", "Hamilton-Wentworth DSB", "Halifax RCE", "Toronto DSB", "Peel DSB", "Durham DSB", "York Region DSB", "Ottawa-Carleton DSB", "Waterloo Region DSB"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function onRequest({ request }) {
  const q = String(new URL(request.url).searchParams.get("q") ?? "").toLowerCase();
  await wait(q.length <= 1 ? 1200 : 200);
  return Response.json({ q, results: BOARDS.filter((b) => b.toLowerCase().includes(q)) }, { headers: { "cache-control": "no-store" } });
}
