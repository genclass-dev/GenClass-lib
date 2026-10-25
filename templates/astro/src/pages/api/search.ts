// A tiny search API for the starter: GET /api/search?q=... Each answer takes a random 50-900 ms, so answers to
// earlier keystrokes can arrive after later ones, as on a slow network. Rendered on demand (not prerendered), which
// is what the Node adapter in astro.config.mjs is for. Replace it with your own backend.
import type { APIRoute } from "astro";

export const prerender = false;

const CITIES = ["Amsterdam", "Athens", "Auckland", "Barcelona", "Berlin", "Bern", "Bogota", "Boston", "Brussels", "Budapest", "Cairo", "Lagos", "Lima", "Lisbon", "London", "Lyon", "Madrid", "Manila", "Melbourne", "Milan", "Montreal", "Munich", "Paris", "Porto", "Prague", "San Diego", "San Francisco", "San Jose", "Santiago", "Seattle", "Seoul", "Sydney", "Toronto", "Vienna", "Warsaw", "Zurich"];

export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const results = q ? CITIES.filter((c) => c.toLowerCase().startsWith(q)) : [];
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 850));
  return Response.json({ q, results });
};
