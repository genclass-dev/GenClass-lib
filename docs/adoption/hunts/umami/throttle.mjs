// The same typing on Umami's list search without GenClass and without intercepting any request: Chromium's own network
// emulation (the DevTools throttling presets, through CDP) adds round-trip latency to every request, as a phone on a
// slow connection would. Prints how many trials lost typed text. Not part of any test suite.
//
// Usage (Umami on 3000, seeded with seed.mjs): node docs/adoption/hunts/umami/throttle.mjs [--trials 10] [--out file]
// Environment: UMAMI_URL (default http://localhost:3000), UMAMI_USER / UMAMI_PASSWORD (default admin / umami).

import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const TRIALS = Number(opt("trials", 10));
const OUT = opt("out", null);
const APP = (process.env.UMAMI_URL ?? "http://localhost:3000").replace(/\/$/, "");
// Round-trip latency added to every request, ms. 150 and 400 are close to Chrome DevTools' "Fast 4G" and "Slow 4G"
// latencies (bandwidth is not limited here; the RSC payloads are small).
const LATENCIES = opt("latency", "0,150,400").split(",").map(Number);
// [page, path, first burst, pause ms, second burst]: a pause just over DataGrid's 600 ms debounce, then more typing.
const CASES = [
  ["websites", "/websites", "shop", 700, " stu"],
  ["users", "/admin/users", "anna", 700, "_sto"],
];

const login = await fetch(`${APP}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: process.env.UMAMI_USER ?? "admin", password: process.env.UMAMI_PASSWORD ?? "umami" }),
});
const { token } = await login.json();
if (!token) throw new Error(`login failed: ${login.status}`);

const browser = await chromium.launch();
const results = [];
for (const latency of LATENCIES) {
  for (const [name, path, a, pause, b] of CASES) {
    const values = [];
    for (let i = 0; i < TRIALS; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      await ctx.addInitScript((t) => localStorage.setItem("umami.auth", JSON.stringify(t)), token);
      const page = await ctx.newPage();
      await page.goto(APP + path);
      const box = page.getByRole("searchbox");
      await box.waitFor();
      if (latency) {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });
      }
      await box.click();
      await box.pressSequentially(a, { delay: 90 });
      await page.waitForTimeout(pause);
      await box.pressSequentially(b, { delay: 90 });
      // long enough for the last debounce (600 ms) and its navigation at this latency
      await page.waitForTimeout(600 + 4 * latency + 1500);
      values.push(await box.inputValue());
      await ctx.close();
    }
    const lost = values.filter((v) => v !== a + b).length;
    results.push({ latency, page: name, typed: a + b, trials: TRIALS, lost, values });
    console.log(`latency ${latency} ms · ${name}: typed ${JSON.stringify(a + b)}, lost text in ${lost} of ${TRIALS} (${[...new Set(values)].map((v) => JSON.stringify(v)).join(" ")})`);
  }
}
if (OUT) writeFileSync(OUT, JSON.stringify({ app: APP, at: new Date().toISOString(), results }, null, 2));
await browser.close();
