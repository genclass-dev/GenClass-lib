// Logs in through the UI once and saves the session (cookies + localStorage) for the hunt runs.
import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.goto("http://localhost:3000/login", { waitUntil: "networkidle", timeout: 120000 });
await page.screenshot({ path: "/home/user/hunt/shots/login.png" });
const inputs = await page.locator("input").evaluateAll((els) => els.map((e) => ({ type: e.type, name: e.name, id: e.id, label: e.getAttribute("aria-label") })));
console.log(JSON.stringify(inputs));
await page.locator("input[type=text], input[type=email]").first().fill("changeme@example.com");
await page.locator("input[type=password]").fill("MyPassword");
await page.locator("button[type=submit]").click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
await page.waitForLoadState("networkidle");
console.log("at", page.url());
await page.screenshot({ path: "/home/user/hunt/shots/home.png" });
await ctx.storageState({ path: "/home/user/hunt/harness/state.json" });
await b.close();
