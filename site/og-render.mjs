// Renders src/og.svg to public/og.png (1200x630, the social card) in Chromium with the site's web fonts (Satoshi from
// Fontshare, JetBrains Mono from Google Fonts), which og.sh's qlmanage cannot load. Run it on the train VM after the
// root `npm ci` (it uses the repo's Playwright): `node site/og-render.mjs`. Bump the ?v= on og.png in build.py after.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, "..", "package.json"))("@playwright/test");
const mark = readFileSync(join(here, "public/brand/mark-512.png")).toString("base64");
const svg = readFileSync(join(here, "src/og.svg"), "utf8").replaceAll('href="../public/brand/mark-512.png"', `href="data:image/png;base64,${mark}"`);
const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>html,body{margin:0;background:#000}svg{display:block}</style></head><body>${svg}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle" });
const fonts = await page.evaluate(async () => {
  await document.fonts.ready;
  return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family);
});
if (!fonts.includes("Satoshi") || !fonts.includes("JetBrains Mono")) throw new Error(`web fonts did not load: ${fonts.join(", ") || "none"}`);
await page.screenshot({ path: join(here, "public/og.png"), clip: { x: 0, y: 285, width: 1200, height: 630 } });
await browser.close();
console.log("wrote site/public/og.png (1200x630) with", [...new Set(fonts)].join(", "));
