// `genclass-runtime scan <url>` (alias `audit`; also `npx @genclass/runtime@beta scan <url>`; owner: INSTALL).
//
// Audits one page with the runtime's measured visual checks (docs/runtime/VISUAL.md) and prints a report: a score,
// then each finding with its count, the element the runtime describes, its selector and the suggested CSS fix,
// grouped by severity. `--json` prints the same report as JSON on stdout and nothing else there.
//
// Local (the default): when Playwright (`playwright`, `playwright-core` or `@playwright/test`) resolves from the
// project, from this package or from the global node_modules, and its Chromium is installed, it loads the page in
// headless Chromium at desktop and phone sizes with the runtime's script-tag build (dist/genclass.global.min.js of
// this package) injected before the page's first script: observe mode, telemetry off, no model, visual checks on.
// The runtime's files are served from disk on a virtual same-origin path (as @genclass/playwright does), so the only
// requests are the page's own. It waits for the load and a quiet network, runs a check pass (rt.checkNow(), which
// includes the persistence re-checks) and reads rt.checks(). Observe never changes the page.
//
// Hosted (`--hosted`, or when Playwright or its Chromium is missing): the genclass.dev page check (genclass-scan, a
// Cloudflare browser that runs the same checks plus axe-core, speed, security and race probes) loads the page
// remotely; the report says so. A loopback or private address is never sent there. Playwright is detected with
// createRequire and imported only when found; it is never a dependency of this package (AGENTS.md rule 7).
//
// Exit code: 0 nothing found, 1 the checks found something, 2 an error (nothing was measured).

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { c, err, out, sym } from "./ui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(HERE, "..", "..");
const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).version);
  } catch {
    return "0.0.0";
  }
})();

/** The hosted page check. GENCLASS_SCAN_HOSTED points the CLI at a test copy (tests use a local mock). */
export const HOSTED = "https://genclass-scan.mehar-144.workers.dev";
/** The virtual same-origin path the runtime's dist/ is served on inside the scanned page. */
export const RUNTIME_PATH = "/__genclass_scan__/";
export const INSTALL_LINE = "npx playwright install chromium";

const VIEWS = {
  desktop: { id: "desktop", width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { id: "phone", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const SEVERITIES = ["critical", "high", "serious", "medium", "moderate", "low", "minor"];
const SEV_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

// The hosted check's "Visual bugs" category (scan-worker src/score.ts and catalog.ts, scan-score/4), so a local score
// and the hosted category agree on the same findings: high/medium/low read as serious/moderate/minor, and the kinds
// that make the whole page unusable are critical when measured as high.
const POINTS = { critical: 50, serious: 25, moderate: 15, minor: 12 };
const FOUR_LEVEL = { high: "serious", medium: "moderate", low: "minor" };
const CRITICAL_KINDS = new Set(["page-blank", "pointer-events-leak", "scroll-lock-stuck"]);
const SCORE_BASIS = "the visual checks scored like the Visual bugs category of the genclass.dev page check (scan-score/4)";

export const USAGE = `Usage:
  genclass-runtime scan <url> [--json] [--phone] [--timeout <s>] [--hosted | --local]
  genclass-runtime audit <url> ...   (the same command)

Audits one page with GenClass's 23 measured visual checks (unreadable text, broken images, fonts and
stylesheets, sideways scrolling, layers that swallow clicks, covered dialogs, template leaks, ...) and prints
a score and each problem with the element, its selector and a suggested CSS fix, worst first.

By default it runs on this computer: headless Chromium through Playwright, at desktop (1280x800) and phone
(390x844) sizes, with the runtime injected in observe mode (telemetry off, no model; nothing is sent). It
needs Playwright's Chromium: npm i -D playwright && ${INSTALL_LINE}
Without it, or with --hosted, the page is checked remotely by the genclass.dev page check
(${HOSTED}), which also runs accessibility, speed and security audits; localhost and private
addresses are never sent there.

  --json         the report as JSON on stdout (nothing else on stdout)
  --phone        the phone size only
  --timeout <s>  page load timeout per size (default 30; hosted: the whole scan, default 120)
  --hosted       run on the genclass.dev page check instead of locally
  --local        never use the hosted check: without Playwright's Chromium, stop (exit 2)

Exit code: 0 nothing found, 1 problems found, 2 error.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { json: false, phone: false, hosted: false, local: false, help: false, timeout: null, url: null, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const value = () => {
      const v = eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === "") throw new UsageError(`${key} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--json") o.json = true;
    else if (a === "--phone") o.phone = true;
    else if (a === "--hosted") o.hosted = true;
    else if (a === "--local") o.local = true;
    else if (key === "--timeout") {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0 || n > 600) throw new UsageError("--timeout must be a number of seconds between 1 and 600");
      o.timeout = n;
    } else if (key === "--cwd") o.cwd = resolve(value());
    else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else if (o.url === null) o.url = a;
    else throw new UsageError(`one URL at a time (got ${o.url} and ${a})`);
  }
  return o;
}

/** The URL to scan: https:// added to a bare host; http(s) only; no credentials. Throws UsageError. */
export function normaliseUrl(raw) {
  let s = String(raw).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${/^(localhost|127\.|\[::1\])/i.test(s) ? "http" : "https"}://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new UsageError(`not a URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`only http and https pages can be scanned (got ${u.protocol})`);
  if (u.username || u.password) throw new UsageError("leave credentials out of the URL");
  return u.href;
}

/** A loopback, private or link-local address (or a name only this network knows): never sent to the hosted check. */
export function privateHost(href) {
  const h = new URL(href).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".test") || !h.includes(".") && !h.includes(":")) return true;
  if (/^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (h.includes(":") && (h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:"))) return true;
  return false;
}

// ------------------------------------------------------------------------------------------- Playwright

/** Where a global npm install keeps its packages, without spawning npm. */
function globalRoots() {
  const roots = [];
  for (const p of String(process.env.NODE_PATH || "").split(process.platform === "win32" ? ";" : ":")) if (p) roots.push(p);
  if (process.env.npm_config_prefix) roots.push(join(process.env.npm_config_prefix, process.platform === "win32" ? "node_modules" : join("lib", "node_modules")));
  const bin = dirname(process.execPath);
  roots.push(process.platform === "win32" ? join(bin, "node_modules") : join(bin, "..", "lib", "node_modules"));
  return roots;
}

/**
 * The first Playwright package that resolves from the project, from this package or globally: { name, path }, or
 * null. GENCLASS_SCAN_PLAYWRIGHT=none pretends there is none (tests).
 */
export function findPlaywright(cwd) {
  if (process.env.GENCLASS_SCAN_PLAYWRIGHT === "none") return null;
  const bases = [join(cwd, "package.json"), join(PKG_DIR, "package.json"), ...globalRoots().map((r) => join(r, "noop.js"))];
  for (const base of bases) {
    const req = createRequire(base);
    for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
      try {
        return { name, path: req.resolve(name) };
      } catch {
        /* next */
      }
    }
  }
  return null;
}

const CONTENT_TYPES = { ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8" };

/** The init script: the runtime's configuration, then the script-tag build with a stand-in tag for data-base. */
function initScript(distDir) {
  const global = readFileSync(join(distDir, "genclass.global.min.js"), "utf8");
  const config = { mode: "observe", telemetry: false, model: false, visual: { on: true }, analytics: false, devtools: false, report: "silent", sinks: [] };
  return `(function () {
  try { if (window.top !== window) return; } catch (e) { return; }
  if (!/^https?:$/.test(location.protocol) || window.__GENCLASS_SCAN__) return;
  window.__GENCLASS_SCAN__ = true;
  window.GENCLASS_CONFIG = ${JSON.stringify(config)};
  var tag = document.createElement("script");
  tag.dataset.base = ${JSON.stringify(RUNTIME_PATH)};
  Object.defineProperty(document, "currentScript", { configurable: true, get: function () { return tag; } });
  try {
    (function () {
${global}
    })();
  } catch (e) {
    window.__GENCLASS_SCAN_ERROR__ = String(e && e.message || e);
  } finally {
    delete document.currentScript;
  }
})();\n`;
}

/** The file inside dist/ a request for RUNTIME_PATH names, or null. */
function runtimeFile(distDir, url) {
  let path;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const i = path.indexOf(RUNTIME_PATH);
  if (i < 0) return null;
  const rel = path.slice(i + RUNTIME_PATH.length);
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(rel) || rel.split("/").some((s) => s === "." || s === "..")) return null;
  const abs = resolve(distDir, ...rel.split("/"));
  return abs.startsWith(resolve(distDir) + sep) && existsSync(abs) ? abs : null;
}

// Runs in the page: the first check pass (it loads the checks' chunk if needed, with its persistence re-checks).
// Serialised with toString(): no closures over this module.
async function firstPassInPage() {
  const w = window;
  const rt = w.GenClass && w.GenClass.runtime;
  if (!rt || typeof rt.checkNow !== "function") return { error: w.__GENCLASS_SCAN_ERROR__ || "the runtime did not start on this page" };
  try {
    await rt.checkNow();
    return { error: null };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Runs in the page: whether the page is scrolled to its end.
function atEndInPage() {
  const d = document.scrollingElement || document.documentElement;
  return d.scrollTop + window.innerHeight >= d.scrollHeight - 2;
}

// Runs in the page: every finding the runtime kept, as plain data, and what the checks covered.
function collectInPage() {
  const w = window;
  const rt = w.GenClass && w.GenClass.runtime;
  if (!rt || typeof rt.checks !== "function") return { error: w.__GENCLASS_SCAN_ERROR__ || "the runtime did not start on this page" };
  const s = rt.summary && rt.summary();
  const v = (s && s.visual) || null;
  const plain = (o) => {
    const r = {};
    for (const [k, x] of Object.entries(o || {})) if (typeof x === "number" || typeof x === "string" || typeof x === "boolean") r[k] = x;
    return r;
  };
  const findings = rt.checks(200).map((f) => ({
    kind: f.kind,
    severity: f.severity,
    target: f.target,
    selector: f.selector,
    message: f.message,
    count: f.count || 1,
    route: f.route || null,
    measured: plain(f.measured),
    threshold: f.threshold ? { value: f.threshold.value, unit: f.threshold.unit, source: f.threshold.source } : null,
    suggestion: f.suggestion ? { selector: f.suggestion.selector, css: f.suggestion.css, note: f.suggestion.note || null } : null,
  }));
  return {
    error: v ? null : "the visual checks did not run on this page",
    findings,
    passes: v ? v.passes : 0,
    elements: v ? v.elements : 0,
    partial: v ? v.partial : 0,
    unsupported: v ? v.unsupported : [],
    tier: v ? v.tier : null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** page.evaluate with a deadline (a page that never yields must not hang the scan). */
const evaluateWithin = (page, fn, ms) =>
  Promise.race([page.evaluate(`(${fn.toString()})()`), new Promise((r) => setTimeout(() => r({ error: "the check pass did not finish in time" }), ms).unref())]);

/**
 * What the hosted check does between its first pass and reading the findings, so the interaction checks have
 * something to see: Tab four times on the desktop (focus-obscured), then wheel down over the middle of the page to
 * its end (control-unreachable under fixed bars, layout shifts on scroll). Moves focus and scroll only.
 */
async function interact(page, view) {
  if (!view.isMobile) {
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab").catch(() => undefined);
      await sleep(250);
    }
  }
  await page.mouse.move(view.width / 2, view.height / 2).catch(() => undefined);
  for (let i = 0; i < 4; i++) {
    if (await page.evaluate(`(${atEndInPage.toString()})()`).catch(() => true)) break;
    await page.mouse.wheel(0, 700).catch(() => undefined);
    await sleep(300);
  }
  // control-unreachable measures 500 ms after scrolling stops, in an idle callback, and confirms 1,000 ms later
  // (VISUAL.md 3.21); 2.5 s caught it on the scanner's fixture page half the time, 4 s every time
  await sleep(4000);
}

async function scanView(browser, distDir, script, url, view, timeoutMs, bypassCSP) {
  const started = Date.now();
  const ua = view.isMobile ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split(".")[0]}.0.0.0 Mobile Safari/537.36` : undefined;
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.deviceScaleFactor,
    isMobile: view.isMobile,
    hasTouch: view.hasTouch,
    ...(ua ? { userAgent: ua } : {}),
    bypassCSP,
  });
  const res = { id: view.id, width: view.width, height: view.height, status: null, ok: false, ms: 0, passes: 0, elements: 0, unsupported: [], error: null, findings: [] };
  try {
    await context.route(`**${RUNTIME_PATH}**`, async (route) => {
      try {
        const file = runtimeFile(distDir, route.request().url());
        if (!file) return await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
        await route.fulfill({ status: 200, headers: { "content-type": CONTENT_TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" }, body: readFileSync(file) });
      } catch {
        /* the page closed */
      }
    });
    await context.addInitScript({ content: script });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    res.status = response ? response.status() : null;
    await page.waitForLoadState("networkidle", { timeout: Math.min(5000, timeoutMs) }).catch(() => undefined);
    const first = await evaluateWithin(page, firstPassInPage, Math.max(15000, timeoutMs));
    if (!first.error) await interact(page, view);
    const r = first.error ? first : await evaluateWithin(page, collectInPage, 5000);
    Object.assign(res, { passes: r.passes ?? 0, elements: r.elements ?? 0, unsupported: r.unsupported ?? [], findings: r.findings ?? [], error: r.error ?? null });
    res.ok = !res.error;
  } catch (e) {
    res.error = String(e?.message || e).split("\n")[0];
  } finally {
    res.ms = Date.now() - started;
    await context.close().catch(() => undefined);
  }
  return res;
}

/** Findings of every view merged: one per kind and element (or suggested selector), with the views it showed in. */
export function mergeFindings(views) {
  const by = new Map();
  for (const v of views) {
    for (const f of v.findings) {
      const key = `${f.kind}\u0000${f.suggestion?.selector || f.selector}`;
      const m = by.get(key);
      if (!m) {
        by.set(key, { ...f, views: [v.id] });
        continue;
      }
      if (!m.views.includes(v.id)) m.views.push(v.id);
      m.count = Math.max(m.count, f.count);
      if (SEV_RANK[f.severity] < SEV_RANK[m.severity]) m.severity = f.severity;
    }
  }
  return [...by.values()].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count || a.kind.localeCompare(b.kind));
}

/** 0..100 from merged local findings (the hosted check's Visual bugs formula); null when nothing was measured. */
export function visualScore(findings) {
  const rules = new Map();
  for (const f of findings) {
    const four = FOUR_LEVEL[f.severity] === "serious" && CRITICAL_KINDS.has(f.kind) ? "critical" : FOUR_LEVEL[f.severity] || "minor";
    const r = rules.get(f.kind) || { severity: four, n: 0 };
    if (POINTS[four] > POINTS[r.severity]) r.severity = four;
    r.n += f.count || 1;
    rules.set(f.kind, r);
  }
  let p = 1;
  for (const r of rules.values()) p *= 1 - (POINTS[r.severity] * Math.min(3, 1 + Math.log10(Math.max(1, r.n)))) / 100;
  return Math.round(100 * Math.max(0, p));
}

const summaryOf = (findings) => {
  const s = { total: findings.length };
  for (const f of findings) s[f.severity] = (s[f.severity] || 0) + 1;
  return s;
};

async function scanLocal(pw, url, o, notes) {
  const distDir = join(PKG_DIR, "dist");
  if (!existsSync(join(distDir, "genclass.global.min.js")) || !existsSync(join(distDir, "visual", "index.js"))) {
    throw new Error(`${distDir} has no script-tag build (genclass.global.min.js and visual/index.js); run npm run build -w @genclass/runtime`);
  }
  const mod = await import(pathToFileURL(pw.path).href);
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error(`${pw.name} has no chromium launcher`);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    const m = String(e?.message || e);
    if (/Executable doesn't exist|playwright install/i.test(m)) return { missing: true, reason: `${pw.name} is installed but its Chromium is not` };
    throw e;
  }
  try {
    const script = initScript(distDir);
    const timeoutMs = (o.timeout ?? 30) * 1000;
    const views = [];
    for (const view of o.phone ? [VIEWS.phone] : [VIEWS.desktop, VIEWS.phone]) {
      let r = await scanView(browser, distDir, script, url, view, timeoutMs, false);
      // a strict Content-Security-Policy can refuse the checks' chunk: measure again with the page's CSP off
      if (!r.ok && r.status !== null && /did not run|did not start/.test(r.error || "")) {
        const again = await scanView(browser, distDir, script, url, view, timeoutMs, true);
        if (again.ok) {
          r = again;
          notes.push(`${view.id}: the page's Content-Security-Policy refused the checks, so this size was measured with it off (csp-blocked cannot be measured there)`);
        }
      }
      views.push(r);
    }
    return { browser: `Chromium ${browser.version()}`, views };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** The local report from the views' raw results. */
export function localReport(url, views, browserName, notes) {
  const measured = views.filter((v) => v.ok);
  const findings = mergeFindings(measured).map((f) => ({
    kind: f.kind,
    severity: f.severity,
    count: f.count,
    views: f.views,
    target: f.target,
    selector: f.selector,
    // without the runtime's "[GenClass] Check (measured):" prefix, and without its closing suggestion (it is `fix`)
    message: String(f.message || "")
      .replace(/^\[GenClass\]\s*(Check \(measured\):\s*)?/, "")
      .replace(f.suggestion ? /\s*Suggested CSS: .*$/ : /$^/, ""),
    fix: f.suggestion ? `${f.suggestion.selector} { ${f.suggestion.css} }` : null,
    fixNote: f.suggestion?.note ?? null,
    measured: f.measured,
    threshold: f.threshold,
    route: f.route,
  }));
  for (const v of measured) if (v.status >= 400) notes.push(`${v.id}: the page answered HTTP ${v.status}, so this is the error page that was checked`);
  return {
    format: "genclass-scan/1",
    url,
    ranAt: "local",
    runtime: VERSION,
    browser: browserName,
    score: measured.length ? { value: visualScore(findings), basis: SCORE_BASIS } : { value: null, basis: SCORE_BASIS },
    summary: summaryOf(findings),
    views: views.map((v) => ({ id: v.id, width: v.width, height: v.height, status: v.status, ok: v.ok, ms: v.ms, passes: v.passes, elements: v.elements, unsupported: v.unsupported, error: v.error })),
    findings,
    notes,
  };
}

// ------------------------------------------------------------------------------------------------ hosted

async function readStream(res, onProgress) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === "progress") onProgress(m.step);
      else if (m.type === "done") return { report: m.report };
      else if (m.type === "error") return { error: `${m.message || "the hosted scan failed"}${m.code ? ` (${m.code})` : ""}` };
    }
    if (done) return { error: "the hosted scan ended without a report" };
  }
}

/** POST /api/scan on the hosted check: its report (a cache hit or the end of the stream), or { error }. */
async function fetchHosted(url, o, progress) {
  const base = (process.env.GENCLASS_SCAN_HOSTED || HOSTED).replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, application/x-ndjson", "user-agent": `genclass-runtime-cli/${VERSION}` },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout((o.timeout ?? 120) * 1000),
    });
  } catch (e) {
    return { error: `could not reach the hosted page check at ${base}: ${e?.cause?.code || e?.cause?.message || e?.message || e}` };
  }
  const type = res.headers.get("content-type") || "";
  if (type.includes("ndjson") && res.body) return readStream(res, progress);
  let j = null;
  try {
    j = await res.json();
  } catch {
    j = null;
  }
  if (j && j.ok && j.report) return { report: j.report };
  const retry = res.headers.get("retry-after");
  return { error: `${j?.message || `the hosted page check answered HTTP ${res.status}`}${j?.code ? ` (${j.code})` : ""}${retry ? `; try again in ${retry} s` : ""}` };
}

/** The common report shape from the hosted check's report (scan-worker src/report.ts Report). */
export function hostedReport(url, r, base) {
  const findings = (Array.isArray(r.findings) ? r.findings : [])
    .filter((f) => !f.unscored)
    .map((f) => ({
      kind: f.rule || f.kind,
      severity: f.severity,
      category: f.category,
      count: f.count || 1,
      views: f.views || [],
      target: f.what || "",
      selector: f.selector || "",
      message: f.measured || f.why || "",
      fix: f.fix || null,
      fixNote: null,
      standards: (f.standards || []).map((s) => s.label || s.id || s.url).filter(Boolean),
    }))
    .sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || b.count - a.count);
  const unscored = (Array.isArray(r.findings) ? r.findings : []).filter((f) => f.unscored).length;
  const notes = [];
  if (r.scoreNote) notes.push(r.scoreNote);
  if (unscored) notes.push(`${unscored} more listed but not scored on the full report`);
  for (const [cat, why] of Object.entries(r.notMeasured || {})) notes.push(`${cat} not measured: ${why}`);
  return {
    format: "genclass-scan/1",
    url,
    ranAt: "hosted",
    runtime: r.runtime || null,
    browser: r.chrome ? `Chromium ${r.chrome} (genclass.dev page check)` : "genclass.dev page check",
    score: { value: r.score?.value ?? null, basis: `the genclass.dev page check's overall score (${r.score?.version || "scan-score"})` },
    categories: (r.score?.categories || []).map((cat) => ({ id: cat.id, label: cat.label, value: cat.value, measured: cat.measured, count: cat.count })),
    top: (r.top || []).map((t) => ({ rule: t.rule, category: t.category, what: t.what, severity: t.severity, count: t.count, points: t.points })),
    summary: summaryOf(findings),
    views: (r.views || []).map((v) => ({ id: v.id, width: v.width, height: v.height, status: v.status ?? null, ok: !!v.ok, ms: v.ms ?? null, error: v.error ?? null })),
    findings,
    blocked: r.blocked ? r.blocked.message : null,
    fullReport: `${base}/scan?url=${encodeURIComponent(url)}`,
    scannedAt: r.scannedAt || null,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------- printing

const SEV_COLOR = { critical: c.red, high: c.red, serious: c.red, medium: c.yellow, moderate: c.yellow, low: c.gray, minor: c.gray };

/** The report as terminal text. */
export function formatReport(rep) {
  const lines = [];
  const p = (s = "") => lines.push(s);
  p();
  p(`  ${c.bold(c.magenta("GenClass scan"))} ${c.gray(sym.dot)} ${c.bold(rep.url)}`);
  const sizes = rep.views.map((v) => `${v.id} ${v.width}x${v.height}`).join(", ");
  if (rep.ranAt === "local") p(c.gray(`  ran locally: ${rep.browser}, ${sizes}; @genclass/runtime ${rep.runtime} visual checks in observe mode (no telemetry, no model, nothing sent)`));
  else p(c.gray(`  ran remotely on the genclass.dev page check (${sizes || "desktop and phone"}): the page was loaded by its browser, not this computer`));
  for (const v of rep.views) if (v.error) p(`  ${c.yellow(sym.warn)} ${v.id}: ${v.error}`);
  p();
  const n = rep.findings.length;
  const counts = SEVERITIES.filter((s) => rep.summary[s]).map((s) => `${rep.summary[s]} ${s}`).join(", ");
  const score = rep.score.value === null ? "no score" : `${rep.ranAt === "local" ? "Visual score" : "Score"} ${c.bold(`${rep.score.value}/100`)}`;
  p(`  ${score}  ${c.gray(sym.dot)}  ${n === 0 ? c.green(`${sym.ok} no problems found`) : `${n} problem${n === 1 ? "" : "s"} (${counts})`}`);
  if (rep.blocked) p(`  ${c.yellow(sym.warn)} ${rep.blocked}`);
  if (rep.categories?.length) {
    p();
    for (const cat of rep.categories) p(`  ${cat.label.padEnd(20)} ${cat.measured ? String(cat.value).padStart(3) : "  -"}${cat.measured ? "" : c.gray("  not measured")}`);
  }
  if (rep.top?.length) {
    p();
    p(`  ${c.bold("Top issues")}`);
    for (const t of rep.top) p(`  ${sym.dot} ${t.what} ${c.gray(`(${t.severity}${t.count > 1 ? `, ${t.count}` : ""}, costs ${Math.round(t.points)} points)`)}`);
  }
  let sev = null;
  for (const f of rep.findings) {
    if (f.severity !== sev) {
      sev = f.severity;
      p();
      p(`  ${SEV_COLOR[sev] ? SEV_COLOR[sev](c.bold(sev.toUpperCase())) : c.bold(sev.toUpperCase())}`);
    }
    const where = f.views?.length ? c.gray(` (${f.views.join(", ")})`) : "";
    p(`  ${(SEV_COLOR[f.severity] || ((s) => s))(sym.cross)} ${c.bold(f.kind)}${f.count > 1 ? ` x${f.count}` : ""}${where}`);
    if (f.target) p(`      ${f.target}${f.selector ? c.gray(`  ${f.selector}`) : ""}`);
    else if (f.selector) p(`      ${c.gray(f.selector)}`);
    const msg = f.message;
    const indent = (t) => String(t).replace(/\n+/g, "\n        ");
    if (msg && msg !== f.target) p(`      ${indent(msg)}`);
    if (f.fix) p(`      ${c.green("fix:")} ${indent(f.fix)}${f.fixNote ? c.gray(`  (${f.fixNote})`) : ""}`);
  }
  if (rep.notes?.length) {
    p();
    for (const note of rep.notes) p(c.gray(`  note: ${note}`));
  }
  p();
  if (rep.ranAt === "local") p(c.gray(`  Score: ${rep.score.basis}. Accessibility, speed and security too: add --hosted.`));
  else p(c.gray(`  Full report: ${rep.fullReport}`));
  p();
  return lines.join("\n");
}

// ------------------------------------------------------------------------------------------------- run

/** `scan` / `audit`: returns the exit code. */
export async function run(cmd, argv) {
  let o;
  let url;
  try {
    o = parseArgs(argv);
    if (o.help) {
      out(USAGE);
      return 0;
    }
    if (!o.url) throw new UsageError(`${cmd} needs a URL`);
    if (o.hosted && o.local) throw new UsageError("--hosted and --local contradict each other");
    url = normaliseUrl(o.url);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`genclass-runtime ${cmd}: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  const say = (s) => err(c.gray(s));
  const notes = [];
  let rep = null;
  try {
    let hosted = o.hosted;
    if (!hosted) {
      const pw = findPlaywright(o.cwd);
      let missing = pw ? null : "Playwright is not installed here";
      if (pw) {
        const r = await scanLocal(pw, url, o, notes);
        if (r.missing) missing = r.reason;
        else rep = localReport(url, r.views, r.browser, notes);
      }
      if (missing) {
        err(`${c.yellow(sym.warn)} ${missing}, so this scan cannot run on this computer. To run it locally:`);
        err(`    npm i -D playwright && ${INSTALL_LINE}`);
        if (o.local) {
          err(`genclass-runtime ${cmd}: --local: not scanned (without --local, a public page is checked on the genclass.dev page check instead).`);
          return 2;
        }
        if (privateHost(url)) {
          err(`genclass-runtime ${cmd}: ${new URL(url).host} is a local address, which the hosted page check cannot reach (and is never sent to it); install Playwright as above.`);
          return 2;
        }
        say(`  Checking it on the genclass.dev page check instead (the URL is sent to ${HOSTED.replace(/^https:\/\//, "")}; it runs more checks, takes about a minute).`);
        hosted = true;
      }
    }
    if (hosted) {
      if (privateHost(url)) {
        err(`genclass-runtime ${cmd}: ${new URL(url).host} is a local address: the hosted page check cannot reach it and it is never sent there. Run without --hosted (needs Playwright's Chromium: ${INSTALL_LINE}).`);
        return 2;
      }
      const tty = process.stderr.isTTY;
      const got = await fetchHosted(url, o, (step) => {
        if (tty && !o.json) process.stderr.write(`\r\x1b[K  ${c.gray(`hosted check: ${step}`)}`);
      });
      if (tty && !o.json) process.stderr.write("\r\x1b[K");
      if (got.error) {
        err(`genclass-runtime ${cmd}: ${got.error}`);
        return 2;
      }
      rep = hostedReport(url, got.report, (process.env.GENCLASS_SCAN_HOSTED || HOSTED).replace(/\/+$/, ""));
    }
  } catch (e) {
    err(`genclass-runtime ${cmd}: ${e?.message || e}`);
    return 2;
  }
  if (o.json) out(JSON.stringify(rep, null, 2));
  else out(formatReport(rep));
  if (rep.blocked || !rep.views.some((v) => v.ok)) {
    if (!o.json) err(`genclass-runtime ${cmd}: nothing was measured${rep.blocked ? "" : `: ${rep.views.map((v) => v.error).filter(Boolean)[0] || "the page did not load"}`}`);
    return 2;
  }
  return rep.findings.length ? 1 : 0;
}
