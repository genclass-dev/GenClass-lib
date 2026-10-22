#!/usr/bin/env node
// Measures what the page shows: the same impatient visit (the page's own robot, window.vibe.run()) on a slow,
// shuffled network, many times, with GenClass off, watching and eager, and with the fixed code; then on a fast network,
// where nothing is wrong, to count the times eager GenClass stepped in when it should not have (false interventions).
//
//   node examples/terrible-vibe-coder/trials.mjs [--seeds 10] [--out results.json]
//
// Needs Chromium from @playwright/test (npx playwright install chromium). Starts the shop's server itself, on PORT
// (default 4646), with GENCLASS_LOCAL=1 unless GENCLASS_LOCAL=0 (then GenClass comes from jsDelivr). The model always
// comes from jsDelivr (@genclass/runtime-model), so the machine needs the internet.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const SEEDS = Number(arg("seeds", "10"));
const OUT = arg("out", null);
const PORT = Number(process.env.PORT) || 4646;
const BASE = `http://localhost:${PORT}`;

const ARMS = [
  { name: "GenClass off, vibe-coded", gc: "off", code: "buggy", slow: true },
  { name: "GenClass watching, vibe-coded", gc: "watch", code: "buggy", slow: true },
  { name: "GenClass eager, vibe-coded", gc: "eager", code: "buggy", slow: true },
  { name: "GenClass off, fixed", gc: "off", code: "fixed", slow: true },
  { name: "GenClass eager, fixed", gc: "eager", code: "fixed", slow: true },
  { name: "GenClass eager, vibe-coded, fast network", gc: "eager", code: "buggy", slow: false },
];

const server = spawn(process.execPath, [join(here, "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), GENCLASS_LOCAL: process.env.GENCLASS_LOCAL ?? "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("http://") && resolve());
  server.on("exit", (c) => reject(new Error(`server exited (${c})`)));
});

const post = (path, body) => fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const browser = await chromium.launch();
const context = await browser.newContext(); // one HTTP cache: the model downloads once
const rows = [];
try {
  for (const arm of ARMS) {
    const r = { arm: arm.name, visits: 0, broke: 0, search: 0, buy: 0, note: 0, interventions: 0, visitsWithIntervention: 0, detections: 0, notReady: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      await post("/api/reset", {});
      await post("/api/network", { slow: arm.slow, seed });
      const page = await context.newPage();
      await page.goto(`${BASE}/?gc=${arm.gc}&code=${arm.code}&claude=0`);
      await page.waitForFunction(() => window.vibe?.run, null, { timeout: 30_000 });
      if (arm.gc !== "off") {
        const ready = await page.evaluate(() => Promise.race([
          window.GenClass.runtime.ready.then(() => true),
          new Promise((r) => setTimeout(() => r(false), 90_000)),
        ]));
        if (!ready) r.notReady++;
        await page.evaluate(() => window.GenClass.runtime.on("decide", (d) => d.detection && (window.__detections = (window.__detections ?? 0) + 1)));
      }
      const v = await page.evaluate(() => window.vibe.run());
      const detections = await page.evaluate(() => window.__detections ?? 0);
      await page.close();
      r.visits++;
      if (v.search || v.buy || v.note) r.broke++;
      if (v.search) r.search++;
      if (v.buy) r.buy++;
      if (v.note) r.note++;
      const n = v.gc?.interventions ?? 0;
      r.interventions += n;
      if (n) r.visitsWithIntervention++;
      r.detections += detections;
      process.stderr.write(`${arm.name} seed ${seed}: ${JSON.stringify(v)}\n`);
    }
    rows.push(r);
  }
} finally {
  await browser.close();
  server.kill();
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
console.log(`\n${SEEDS} visits per row. A visit broke when the search showed an older query, Buy charged twice, or the note lost typing.\n`);
console.log("| | visits that broke | old search | double charge | lost typing | GenClass stepped in (visits) | detections |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows)
  console.log(`| ${r.arm} | ${r.broke} / ${r.visits} (${pct(r.broke, r.visits)}) | ${r.search} | ${r.buy} | ${r.note} | ${r.interventions} (${r.visitsWithIntervention}) | ${r.detections} |`);
const notReady = rows.reduce((a, r) => a + r.notReady, 0);
if (notReady) console.log(`\nThe model was not ready within 90 s in ${notReady} visits (GenClass lets everything through until it is).`);
if (OUT) writeFileSync(OUT, JSON.stringify({ seeds: SEEDS, rows }, null, 2));
