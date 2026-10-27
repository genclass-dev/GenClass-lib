// GET /api/reviews  3.5 s: a slow endpoint, and the page shows nothing while it waits.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  await wait(3500);
  res.setHeader("cache-control", "no-store");
  res.status(200).json({ reviews: [{ who: "A. Reader", text: "Great lamp." }, { who: "B. Typist", text: "Clicky keys." }] });
}
