// Catch rate of the genclass.dev lab's double-click invoice demo, measured in headless Chromium with the real runtime
// and model the page loads. Each run is a fresh visitor (new browser context, empty caches): load the page at #lab,
// wait for the model and for "Double-click both" to enable, press it, then again --clicks-1 more times --gap ms later.
// Per press it records both verdicts and the audit entries the press produced (held, hold budget, latency,
// probabilities, the action that ran and why), including the model's other decisions meanwhile (the stock poll's).
//
// Train VM only (CONTRACT §0.5: never on the Mac):
//   node site/check/dup-demo-measure.mjs --runs 20 [--url https://genclass.dev/] [--index site/public/index.html]
//     [--live-js site/public/live.js] [--unhide] [--query lab-hold=auto] [--clicks 3] [--gap 3000] [--spread 6000]
//     [--clean] [--throttle 2] [--webgpu] [--label name] [--out file.jsonl]
//
// --index and --live-js serve those files for / and /live.js (the live response's headers, CSP included), to measure
// a change before it is deployed. --unhide removes `hidden` from the demo's markup. --spread N: run i presses first
// i × N / runs ms after the button enables, so the presses land at different moments of the page's other decisions.
// --clean presses the GenClass side's own "Send invoice" once instead (no duplicate; one press per visitor, the lanes
// keep counting) and counts false interventions: any action GenClass ran meanwhile, or an invoice count other than 1.
// --throttle sets DevTools CPU throttling, which does not reach the model's worker: for a slower CPU run the command
// under a cgroup quota instead (`sudo systemd-run --scope -p CPUQuota=50% --uid=$USER -- taskset -c 0-3 node ...`).
// --webgpu asks for SwiftShader's WebGPU adapter; on the train VM it has no shader-f16 and a warm-up takes ~19 s, so
// it measures nothing useful there. The runtime skips held decisions in a hidden tab, so every run asserts
// document.visibilityState first.
import { chromium } from "playwright";
import { readFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const base = new URL(opt("url", "https://genclass.dev/"));
const runs = Number(opt("runs", 20));
const clicks = opt("clean", false) ? 1 : Number(opt("clicks", 2));
const gap = Number(opt("gap", 3000));
const spread = Number(opt("spread", 0));
const throttle = Number(opt("throttle", 1));
const query = opt("query", "");
const liveJs = opt("live-js", null);
const index = opt("index", null);
const clean = !!opt("clean", false);
const unhide = !!opt("unhide", false);
const webgpu = !!opt("webgpu", false);
const out = opt("out", null);
const label = opt("label", "");

const launchArgs = webgpu ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader"] : [];
const browser = await chromium.launch({ args: launchArgs, ...(webgpu ? { channel: "chromium" } : {}) });

async function throttleAll(page) {
  if (throttle <= 1) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  // dedicated workers (the model runs in one) are separate targets: throttle them as they attach
  cdp.on("Target.attachedToTarget", async ({ sessionId, targetInfo }) => {
    try {
      if (targetInfo.type === "worker") await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: 1, method: "Emulation.setCPUThrottlingRate", params: { rate: throttle } }) });
      await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: 2, method: "Runtime.runIfWaitingForDebugger" }) });
    } catch {}
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
}

async function one(i) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  if (liveJs) await context.route((u) => u.origin === base.origin && u.pathname === "/live.js", (r) => r.fulfill({ body: readFileSync(liveJs), contentType: "application/javascript" }));
  if (unhide || index) {
    await context.route((u) => u.origin === base.origin && (u.pathname === "/" || u.pathname === "/index.html"), async (r) => {
      const res = await r.fetch(); // the live response's headers (CSP included) with this body
      let body = index ? readFileSync(index, "utf8") : await res.text();
      if (unhide) body = body.replace('<div class="dup" hidden>', '<div class="dup">');
      await r.fulfill({ response: res, body });
    });
  }
  const page = await context.newPage();
  const lines = [];
  page.on("console", (m) => { const t = m.text(); if (t.includes("[GenClass]")) lines.push(t.slice(0, 300)); });
  await throttleAll(page);
  const t0 = Date.now();
  const url = new URL(base);
  if (query) for (const [k, v] of new URLSearchParams(query)) url.searchParams.set(k, v);
  url.searchParams.set("check", String(Date.now()));
  url.hash = "lab";
  await page.goto(url.href, { waitUntil: "load" });
  const vis = await page.evaluate(() => document.visibilityState);
  if (vis !== "visible") throw new Error(`visibilityState is ${vis}: the runtime skips held decisions in a hidden tab`);
  await page.waitForFunction(() => window.GenClass?.runtime?.status?.state === "ready", null, { timeout: 180_000 });
  const model = await page.evaluate(() => {
    const s = GenClass.runtime.status;
    return { device: s.device, variant: s.variant, loadMs: s.loadMs, latency: s.latency, warmupMs: s.warmupMs };
  });
  const readyMs = Date.now() - t0;
  await page.waitForFunction(() => !document.getElementById("dup-go")?.disabled, null, { timeout: 30_000 });
  const res = [];
  // first click: run i waits i × spread / runs ms after the button enabled (an even grid over the spread)
  const firstDelay = Math.round((i * spread) / runs);
  for (let c = 0; c < clicks; c++) {
    await page.waitForTimeout(c ? gap : firstDelay);
    const before = await page.evaluate(() => ({
      seq: Math.max(0, ...GenClass.runtime.audit().map((e) => e.seq)),
      holdBudgetMs: GenClass.runtime.holdBudgetMs(),
      stock: document.getElementById("lk-on-v")?.textContent,
    }));
    if (clean) {
      await page.click("#inv-on-btn");
      await page.waitForFunction(() => /invoice/.test(document.getElementById("inv-on-v")?.textContent || ""), null, { timeout: 30_000 });
    } else {
      await page.click("#dup-go");
      await page.waitForFunction(
        () => /invoice/.test(document.getElementById("inv-on-v")?.textContent || "") && /invoice/.test(document.getElementById("inv-off-v")?.textContent || ""),
        null,
        { timeout: 30_000 },
      );
    }
    await page.waitForTimeout(300); // let late answers and the audit sink settle
    const r = await page.evaluate((seq) => ({
      on: document.getElementById("inv-on-v").textContent,
      off: document.getElementById("inv-off-v").textContent,
      audit: GenClass.runtime.audit().filter((e) => e.seq > seq).map((e) => ({
        seq: e.seq, at: Math.round(e.at), kind: e.kind, trigger: e.trigger, subject: e.subject, diagnosis: e.diagnosis,
        p: e.diagnosisConfidence, proposed: e.proposed, probabilities: e.probabilities, ran: e.ran, executed: e.executed,
        reason: e.reason, held: e.held, holdBudgetMs: e.holdBudgetMs, latencyMs: e.latencyMs, gate: e.gate, ok: e.ok,
        changed: e.changed, error: e.error,
      })),
    }), before.seq);
    const actions = r.audit.filter((e) => e.kind === "action").map((e) => `${e.ran} on ${(e.subject || "").slice(0, 40)}`);
    const caught = clean ? !actions.length && /^1 invoice sent\.$/.test(r.on) : /^1 invoice sent/.test(r.on);
    res.push({ click: c + 1, caught, actions, offTwo: /^2 identical/.test(r.off), holdBudgetBefore: before.holdBudgetMs, ...r });
  }
  await context.close();
  return { run: i + 1, label, readyMs, firstDelay, model, clicks: res, console: lines.slice(-30) };
}

const tally = Array.from({ length: clicks }, () => ({ caught: 0, n: 0 }));
for (let i = 0; i < runs; i++) {
  let r;
  try {
    r = await one(i);
  } catch (e) {
    r = { run: i + 1, label, error: String(e?.message ?? e).slice(0, 500) };
  }
  if (out) appendFileSync(out, JSON.stringify(r) + "\n");
  for (const c of r.clicks ?? []) { tally[c.click - 1].n++; if (c.caught) tally[c.click - 1].caught++; }
  const brief = (r.clicks ?? []).map((c) => {
    const dup = c.audit.find((e) => e.kind === "decision" && e.trigger === "request" && /orders/.test(e.subject || ""));
    if (clean) return `#${c.click} ${c.caught ? "clean" : "FALSE INTERVENTION"}: ${c.actions.join("; ") || "no action"} (${c.on})`;
    return `#${c.click} ${c.caught ? "CAUGHT" : "missed"} ${dup ? `held=${dup.held} budget=${dup.holdBudgetMs} lat=${dup.latencyMs} ran=${dup.ran} diag=${dup.diagnosis} reason=${dup.reason ?? "-"}` : "no decision for the POST"}`;
  });
  console.log(`run ${i + 1}: ${r.error ? `ERROR ${r.error}` : `${r.model.device}/${r.model.variant} ready ${r.readyMs} ms, warm-up ${r.model.warmupMs} ms, first click +${r.firstDelay} ms; ${brief.join(" | ")}`}`);
}
await browser.close();
console.log(`\nsummary ${label}: ` + tally.map((t, i) => (clean ? `${t.caught}/${t.n} clean presses without a false intervention` : `click ${i + 1}: ${t.caught}/${t.n}`)).join(", "));
