// GET /api/profile  An object without the fields the page reads (no `address`): the click handler throws.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  await wait(150);
  res.setHeader("cache-control", "no-store");
  res.status(200).json({ id: 7 });
}
