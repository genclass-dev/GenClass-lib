// Screen recording of the Closed-loop development view (docs/evidence/closed-loop-dashboard/README.md): Chromium
// through Playwright opens the two static pages loop.e2e.ts wrote (the real round trip's data, then the sample app),
// clicks the sidebar's "Closed loop", scrolls through Fig. 3, Table 15 and Fig. 6, and saves the video as
// closed-loop.webm, a GIF of it (ffmpeg, when installed) and three screenshots. Run from the repository root after
// loop.e2e.ts: node docs/evidence/closed-loop-dashboard/record.mjs
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const videoDir = join(here, ".video");
rmSync(videoDir, { recursive: true, force: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: "dark", recordVideo: { dir: videoDir, size: { width: 1360, height: 900 } } });
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);
const walk = async (file, shot) => {
  await page.goto(pathToFileURL(join(here, file)).href + "#top");
  await page.waitForSelector("#loopstages rect[data-stage]", { state: "attached" });
  await pause(1200);
  await page.click('.snav a[href="#loop"]');
  await pause(1600);
  if (shot) await page.screenshot({ path: join(here, shot), fullPage: false });
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 220) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await pause(260);
  }
  await pause(900);
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(700);
};
await walk("page-e2e.html", "01-e2e-closed-loop.png");
await page.evaluate(() => window.scrollTo(0, document.querySelector("#agentlog").getBoundingClientRect().top + window.scrollY - 80));
await pause(400);
await page.screenshot({ path: join(here, "02-e2e-log.png") });
await walk("page-sample.html", "03-sample-closed-loop.png");
await context.close();
await browser.close();
const webm = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
renameSync(join(videoDir, webm), join(here, "closed-loop.webm"));
rmSync(videoDir, { recursive: true, force: true });
console.log("wrote closed-loop.webm, 01-e2e-closed-loop.png, 02-e2e-log.png, 03-sample-closed-loop.png");
const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(here, "closed-loop.webm"), "-vf", "fps=5,scale=820:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=none", join(here, "closed-loop.gif")]);
console.log(ff.status === 0 && existsSync(join(here, "closed-loop.gif")) ? "wrote closed-loop.gif" : `no GIF (ffmpeg ${ff.error ? "not installed" : "failed"}); the .webm is the recording`);
