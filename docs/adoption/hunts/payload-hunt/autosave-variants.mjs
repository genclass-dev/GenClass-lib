// Which part of the injection stops Payload's autosave? Variants of the script tag and the agent connection; each
// types " xyz" into post 2's title and lists the requests that follow.
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";
const LIB = (process.env.GENCLASS_LIB ?? new URL("../../../../", import.meta.url).pathname).replace(/\/+$/, "");
const { serve } = await import(`${LIB}/packages/mcp/dist/index.js`);
const APP = "http://localhost:3000";
const STATE = new URL("./out/storageState.json", import.meta.url).pathname;
const RT_DIST = `${LIB}/packages/runtime/dist`;
const served = await serve({ cwd: process.cwd(), env: {}, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), port: 0, stateDir: null });
const LIVE = `http://127.0.0.1:${served.port}`;
const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks"] });
const CONNECT = (opts) => `import { connectAgent } from "./agent.js";\nwindow.__GENCLASS_CONN__ = connectAgent(window.GenClass && window.GenClass.runtime, ${opts});\n`;
async function variant(name, { tag, connect, bridge, connectOpts = "{}", bursts = false, init = false }) {
  const ctx = await browser.newContext({ storageState: STATE, bypassCSP: true, viewport: { width: 1400, height: 1000 } });
  if (bridge) await ctx.addInitScript((u) => { window.__GENCLASS_AGENT_URL__ = u; }, bridge);
  if (init) await ctx.addInitScript(() => { window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, report: "silent", devtools: false, visual: false, analytics: false }; });
  await ctx.route((u) => u.pathname.startsWith("/__genclass/"), (route, req) => {
    const p = new URL(req.url()).pathname.slice("/__genclass".length);
    if (p === "/__connect.js") return route.fulfill({ status: 200, body: CONNECT(connectOpts), headers: { "content-type": "text/javascript" } });
    return route.fulfill({ status: 200, body: readFileSync(RT_DIST + p), headers: { "content-type": "text/javascript" } });
  });
  if (tag) await ctx.route((u) => u.pathname.startsWith("/admin"), async (route, req) => {
    if (req.resourceType() !== "document") return route.continue();
    const res = await route.fetch();
    const body = (await res.text()).replace(/<head([^>]*)>/i, (m) => m + tag + (connect ? `<script type="module" src="/__genclass/__connect.js"></script>` : ""));
    return route.fulfill({ response: res, body, headers: { ...res.headers(), "content-length": String(Buffer.byteLength(body)) } });
  });
  const page = await ctx.newPage();
  const reqs = [];
  page.on("request", (r) => { if (/\/api\/posts\/2\?|next-action/.test(r.url()) || r.headers()["next-action"]) reqs.push(`${r.method()} ${r.url().replace(APP, "").slice(0, 70)}${r.headers()["next-action"] ? " [action]" : ""}`); });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message).split("\n")[0].slice(0, 80)));
  await page.goto(`${APP}/admin/collections/posts/2`, { waitUntil: "load" });
  await page.locator("#field-title").waitFor();
  await page.waitForTimeout(2500);
  const n0 = reqs.length;
  await page.locator("#field-title").click();
  await page.keyboard.press("End");
  if (bursts) {
    for (const b of [" one", " two", " three", " four"]) {
      await page.locator("#field-title").pressSequentially(b, { delay: 80 });
      await page.waitForTimeout(950);
    }
    await page.waitForTimeout(3000);
  } else {
    await page.locator("#field-title").pressSequentially(" xyz", { delay: 80 });
    await page.waitForTimeout(4000);
  }
  const ui = await page.evaluate(() => ({ status: document.querySelector(".status")?.innerText.replace(/\s+/g, " ").trim(), saveDisabled: document.querySelector("#action-save")?.disabled, autosave: document.querySelector(".autosave")?.innerText }));
  console.log("   ui", JSON.stringify(ui));
  const conn = await page.evaluate(() => window.__GENCLASS_CONN__ ? { connected: window.__GENCLASS_CONN__.connected, reason: window.__GENCLASS_CONN__.reason, schedule: window.__GENCLASS_CONN__.schedule } : null);
  console.log(`${name}: autosave=${reqs.slice(n0).some((r) => r.includes("autosave=true")) ? "YES" : "NO"} requests=${JSON.stringify(reqs.slice(n0))} conn=${JSON.stringify(conn)} errs=${JSON.stringify(errs)}`);
  await ctx.close();
}
const TAG = (extra = "") => `<script src="/__genclass/genclass.global.js" data-base="/__genclass/" data-mode="observe" data-model="off" data-telemetry="off" data-report="silent" ${extra}></script>`;
await variant("H no injection, bursts", { bursts: true });
await variant("I tag + connect live, bursts", { tag: TAG(), connect: true, bridge: LIVE, bursts: true });
await variant("J tag + connect live, single, GENCLASS_CONFIG", { tag: TAG('data-devtools="off" data-visual="off"'), connect: true, bridge: LIVE, init: true });
await variant("K no injection, single", {});
await browser.close();
await served.close();
process.exit(0);
