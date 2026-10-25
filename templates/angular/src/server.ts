// The SSR server Angular generates (ng new --ssr), plus a tiny search API for the starter: GET /api/search?q=...
// Each answer takes a random 50-900 ms, so answers to earlier keystrokes can arrive after later ones, as on a slow
// network. Replace it with your own backend. `ng serve` routes requests through this file too (reqHandler), so the
// API works in development and in the production build (node dist/genclass-angular-starter/server/server.mjs).
import { AngularNodeAppEngine, createNodeRequestHandler, isMainModule, writeResponseToNodeResponse } from "@angular/ssr/node";
import express from "express";
import { join } from "node:path";

const browserDistFolder = join(import.meta.dirname, "../browser");

const app = express();
const angularApp = new AngularNodeAppEngine();

const CITIES = ["Amsterdam", "Athens", "Auckland", "Barcelona", "Berlin", "Bern", "Bogota", "Boston", "Brussels", "Budapest", "Cairo", "Lagos", "Lima", "Lisbon", "London", "Lyon", "Madrid", "Manila", "Melbourne", "Milan", "Montreal", "Munich", "Paris", "Porto", "Prague", "San Diego", "San Francisco", "San Jose", "Santiago", "Seattle", "Seoul", "Sydney", "Toronto", "Vienna", "Warsaw", "Zurich"];

app.get("/api/search", (req, res) => {
  const q = String(req.query["q"] ?? "").trim().toLowerCase();
  const results = q ? CITIES.filter((c) => c.toLowerCase().startsWith(q)) : [];
  setTimeout(() => res.json({ q, results }), 50 + Math.random() * 850);
});

app.use(express.static(browserDistFolder, { maxAge: "1y", index: false, redirect: false }));

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url) || process.env["pm_id"]) {
  const port = Number(process.env["PORT"] || 4000);
  const host = process.env["HOST"] || "localhost";
  app.listen(port, host, (error) => {
    if (error) throw error;
    console.log(`Node Express server listening on http://${host}:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
