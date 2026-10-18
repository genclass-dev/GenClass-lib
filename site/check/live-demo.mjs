// Live demo check for genclass.dev: loads the home page in headless Chromium, waits for the model, presses
// "Double-click both" and asserts that the GenClass side sent one invoice while the plain side sent two.
// Run by .github/workflows/live-demo-check.yml (after a site deploy, and daily). Local use:
//   DEMO_URL=https://genclass.dev/ node site/check/live-demo.mjs
//
// Two runs: the first with the lab's own demo setting (a 1 s hold budget, one question to the model before the button
// turns on), which must pass; the second with the runtime's automatic budget (?lab-hold=auto), which is informational:
// on a slower CPU the automatic budget is often shorter than the duplicate POST's decision. Catch rates per CPU speed:
// site/check/dup-demo-measure.mjs.
//
// The runtime skips held decisions in a hidden tab by design, so the check asserts document.visibilityState first.
import { chromium } from "playwright";

const base = process.env.DEMO_URL || "https://genclass.dev/";
const sep = base.includes("?") ? "&" : "?";

async function run(label, query, { mustPass }) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleLines = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[GenClass]")) consoleLines.push(t);
  });
  const url = `${base}${sep}${query}&check=${Date.now()}`;
  await page.goto(url, { waitUntil: "load" });
  const vis = await page.evaluate(() => document.visibilityState);
  if (vis !== "visible") throw new Error(`${label}: visibilityState is ${vis}; the runtime skips held decisions in a hidden tab, so this run proves nothing`);
  await page.waitForFunction(() => window.GenClass?.runtime?.status?.state === "ready", null, { timeout: 120_000 });
  const model = await page.evaluate(() => {
    const s = GenClass.runtime.status;
    return { device: s.device, variant: s.variant, loadMs: s.loadMs, holdBudgetMs: GenClass.runtime.holdBudgetMs(), latency: s.latency };
  });
  await page.waitForFunction(() => !document.getElementById("dup-go")?.disabled, null, { timeout: 10_000 });
  await page.click("#dup-go");
  await page.waitForFunction(
    () => /invoice/.test(document.getElementById("inv-on-v")?.textContent || "") && /invoice/.test(document.getElementById("inv-off-v")?.textContent || ""),
    null,
    { timeout: 20_000 },
  );
  const result = await page.evaluate(() => {
    const a = GenClass.runtime.audit();
    const recs = Array.isArray(a) ? a : a.decisions || [];
    return {
      on: document.getElementById("inv-on-v").textContent,
      off: document.getElementById("inv-off-v").textContent,
      decisions: recs.map((d) => ({ trigger: d.trigger, diagnosis: d.diagnosis, p: d.diagnosisConfidence, ran: d.ran, executed: d.executed, held: d.held, holdBudgetMs: d.holdBudgetMs, latencyMs: d.latencyMs, reason: d.reason })),
    };
  });
  await browser.close();
  const ok = /^1 invoice sent/.test(result.on) && /^2 identical invoices sent/.test(result.off);
  console.log(`\n== ${label} (${url})`);
  console.log(JSON.stringify({ model, ...result, consoleLines }, null, 2));
  console.log(ok ? `${label}: OK` : `${label}: FAILED (${mustPass ? "blocking" : "informational"})`);
  return ok;
}

const explicit = await run("demo setting (1 s hold budget)", "lab=check", { mustPass: true });
const auto = await run("automatic hold budget", "lab-hold=auto", { mustPass: false });
console.log(`\nsummary: explicit=${explicit ? "ok" : "FAILED"} automatic=${auto ? "ok" : "failed (informational)"}`);
if (!explicit) process.exit(1);
