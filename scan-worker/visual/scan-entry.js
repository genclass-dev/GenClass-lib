// The scanner's side of the GenClass measured visual checks. scripts/build-visual.sh bundles this file with the
// runtime's lazy visual chunk (packages/runtime/dist/visual/index.js, built from branch wave2/visual on CI) into one
// script, src/visual-source.ts, which the scanner runs in Puppeteer's isolated world of each view.
//
// The chunk is used as the runtime uses it: startVisual(rt, options, ...) with a stand-in for the runtime object
// that the chunk's bridge (src/visual/bridge.ts) reads. The stand-in reports the mode the scanner asks for:
//   "observe": the checks report and never change the page (the runtime's observe mode);
//   "guard" with fix: true: the same checks, and the chunk's three opt-in fixes (text colour, a leaked inline
//     pointer-events: none, a leaked inline scroll lock) run behind the chunk's own fix gate, exactly as with
//     GenClass.init({ mode: "guard", visual: { on: true, fix: true } }).
// Nothing here measures or fixes anything itself. It starts and stops engines, collects what they reported, and turns
// each finding into the plain data the scanner stores (src/catalog.ts sanitizeFinding checks it again).
//
// Defines one function, window.__genclassScanVisual(command, argument), on the isolated world's window. The scanner
// takes it only when this script defined it (src/visual.ts installSource) and calls it under a per-scan name.

import { startVisual } from "./dist/visual/index.js";

const PREFIX = "[GenClass] Check (measured): ";
/** Kinds about a file the page loads: dropped when the scanner itself refused to load that file's host. */
const ASSET = new Set(["image-broken", "image-css-broken", "media-failed", "stylesheet-failed", "font-failed", "icon-font-failed", "csp-blocked"]);

const clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  afterTask: (fn) => void setTimeout(fn, 0),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The element's tag and its first words, as the chunk's own checkPage describes elements. */
function describeEl(el) {
  try {
    const name = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
    const tag = el.tagName.toLowerCase();
    return name ? `${tag} "${name}"` : tag;
  } catch (e) {
    return "element";
  }
}

/**
 * The parts of the runtime the chunk's bridge reads (src/visual/bridge.ts RtLike): the clock, the window, the mode,
 * sampling and pause state, the in-flight count (0: the scanner waits for the network to go quiet before it starts
 * the checks), and where findings and fix audits go. Reports are silent: nothing is printed in the page.
 */
function standIn(mode, rec) {
  const teardown = [];
  return {
    clock,
    global: window,
    ops: { inFlight: { size: 0 } },
    isPaused: false,
    vis: null,
    effectiveMode: () => mode,
    summary: () => ({ errors: 0 }),
    on: () => () => undefined,
    addTeardown: (fn) => void teardown.push(fn),
    sessionId: `scan-${rec.id}`,
    sessionTags: {},
    sampled: true,
    reportMode: "silent",
    _aggr: 0,
    reporter: { emit: () => undefined, sink: "silent" },
    sinks: { size: 0, nextId: () => "0", push: () => undefined },
    fire: (type, v) => {
      if (type === "check" && v && rec.findings.length < 200) rec.findings.push(v);
    },
    pushAudit: (make) => {
      try {
        const e = make();
        if (e && e.fix && rec.audit.length < 200) rec.audit.push({ what: String(e.fix.what), kind: String(e.fix.kind), reason: String(e.fix.reason || "") });
      } catch (e) {
        /* ignore */
      }
    },
    auditBase: (kind, m) => ({ kind, mode: m }),
  };
}

const engines = new Map();

function start(o) {
  const id = String(o && o.id);
  if (!/^[a-z]{1,8}$/.test(id) || engines.has(id)) return { ok: false, error: "bad or repeated engine id" };
  const mode = o.mode === "guard" ? "guard" : "observe";
  const rec = { id, mode, fix: mode === "guard" && o.fix === true, findings: [], audit: [], t0: clock.now(), ctl: null, error: "" };
  // CSP violations from before the checks started, recorded by the scanner's safety bootstrap as plain data
  const early = (Array.isArray(o.csp) ? o.csp : []).slice(0, 50).map((e) => ({
    disposition: String((e && e.disposition) || ""),
    effectiveDirective: String((e && e.effectiveDirective) || ""),
    violatedDirective: String((e && e.violatedDirective) || ""),
    blockedURI: String((e && e.blockedURI) || ""),
    sourceFile: String((e && e.sourceFile) || ""),
    target: null,
  }));
  try {
    rec.ctl = startVisual(
      standIn(mode, rec),
      // all kinds on every device ("full"); passes may run up to 1.5 s of idle slices so a long page finishes in one pass
      { on: true, fix: rec.fix, lowEnd: "full", maxConsoleLines: 0, budgetMs: 16, passBudgetMs: 1500 },
      early,
      describeEl,
      (p) => String(p || "/"),
    );
  } catch (e) {
    rec.error = String((e && e.message) || e).slice(0, 160);
    return { ok: false, error: rec.error };
  }
  engines.set(id, rec);
  return { ok: true };
}

function stats(rec) {
  let v = null;
  try {
    const s = rec.ctl.summary();
    v = s && s.visual;
  } catch (e) {
    v = null;
  }
  return {
    passes: v ? v.passes : 0,
    elements: v ? v.elements : 0,
    partial: v ? v.partial : 0,
    abstained: v ? v.abstained : 0,
    ms: v ? Math.round(v.ms) : 0,
    maxSliceMs: v ? v.maxSliceMs : 0,
    fixesApplied: v && v.fixes ? v.fixes.applied : 0,
    fixesUndone: v && v.fixes ? v.fixes.undone : 0,
    unsupported: v && Array.isArray(v.unsupported) ? v.unsupported.slice(0, 4) : [],
    tier: v ? v.tier : "",
    findings: rec.findings.length,
    elapsed: Math.round(clock.now() - rec.t0),
    visibility: document.visibilityState,
  };
}

/** The host of the file a finding is about, when it names one ("" for the page's own origin or none). */
function fileHost(f) {
  let el = null;
  try {
    el = f.element();
  } catch (e) {
    el = null;
  }
  let u = "";
  if (el) u = el.currentSrc || el.src || el.href || "";
  if (!u) {
    const m = f.measured || {};
    u = String(m.src || m.href || m.url || m.blocked || "");
    if (u && !/^[a-z]+:/i.test(u) && !u.startsWith("/")) u = `https://${u}`;
  }
  try {
    return new URL(u, location.href).hostname.toLowerCase();
  } catch (e) {
    return "";
  }
}

/** The element's box in document coordinates, or null (html, body, no element, nothing drawn). */
function boxOf(f) {
  let el = null;
  try {
    el = f.element();
  } catch (e) {
    el = null;
  }
  if (!el || el === document.documentElement || el === document.body) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 || r.height > 0)) return null;
  return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
}

/** A finding as plain data: what the report shows, and the fix state the with-GenClass column needs. */
function serial(f) {
  let text = String(f.message || "");
  if (text.startsWith(PREFIX)) text = text.slice(PREFIX.length);
  const cut = text.search(/ Suggested CSS: | Fix: /);
  const measured = (cut >= 0 ? text.slice(0, cut) : text).trim();
  const details = Array.isArray(f.details) ? f.details : [];
  const fixLine = details.find((l) => typeof l === "string" && l.startsWith("Fix: "));
  const s = f.suggestion;
  const fx = f.fix;
  return {
    kind: f.kind,
    selector: f.selector,
    box: boxOf(f),
    measured,
    detail: {
      severity: f.severity,
      target: f.target,
      css: s ? `${s.selector} { ${s.css} }` : "",
      cssNote: s && s.note ? s.note : "",
      fixText: fixLine ? fixLine.slice(5).replace(/\.$/, "") : "",
      threshold: f.threshold ? `${f.threshold.value} ${f.threshold.unit}` : "",
      state: (f.context && f.context.state) || "",
      count: f.count || 1,
      fixApplied: !!(fx && fx.applied),
      fixCss: fx && fx.css ? fx.css : "",
      fixReason: fx && !fx.applied ? fx.reason || "" : "",
    },
  };
}

async function collect(o) {
  const rec = engines.get(String(o && o.id));
  if (!rec) return { ok: false, error: "no such engine" };
  if (o.pass) {
    // one more pass now (it also re-confirms what is still there), for at most passMs
    await Promise.race([rec.ctl.now().catch(() => []), sleep(Math.max(200, Math.min(4000, Number(o.passMs) || 2500)))]);
  }
  const skip = new Set(Array.isArray(o.skipHosts) ? o.skipHosts.map((h) => String(h).toLowerCase()) : []);
  let skipped = 0;
  const findings = [];
  for (const f of rec.findings) {
    if (skip.size && ASSET.has(f.kind) && skip.has(fileHost(f))) {
      skipped++;
      continue;
    }
    if (findings.length < 40) findings.push(serial(f));
  }
  return { ok: true, findings, skipped, stats: stats(rec), audit: rec.audit.slice(0, 40) };
}

function stop(o) {
  const rec = engines.get(String(o && o.id));
  if (!rec) return { ok: false };
  try {
    rec.ctl.stop(); // undoes every fix this engine applied
  } catch (e) {
    /* ignore */
  }
  engines.delete(rec.id);
  return { ok: true };
}

/** A point over the page itself (not an inner scroller or a fixed bar), for wheel events; as the bench picks it. */
function quietPoint() {
  const W = innerWidth;
  const H = innerHeight;
  for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7])
    for (const fx of [0.5, 0.3, 0.7]) {
      const x = Math.floor(W * fx);
      const y = Math.floor(H * fy);
      let inner = false;
      for (let e = document.elementFromPoint(x, y); e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
        const s = getComputedStyle(e);
        if ((/auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1) || s.position === "fixed") {
          inner = true;
          break;
        }
      }
      if (!inner) return { x, y };
    }
  return { x: Math.floor(W / 2), y: Math.floor(H / 2) };
}

/** What the scanner needs about the page: the layout viewport, the viewport meta tag, the document size. */
function pageInfo() {
  const de = document.documentElement;
  const b = document.body;
  return {
    viewport: [innerWidth, innerHeight],
    viewportMeta: !!document.querySelector('meta[name="viewport" i]'),
    docHeight: Math.max(de.scrollHeight, b ? b.scrollHeight : 0),
    docWidth: Math.max(de.scrollWidth, b ? b.scrollWidth : 0),
    atEnd: scrollY + innerHeight >= de.scrollHeight - 2,
    visibility: document.visibilityState,
  };
}

function scanVisual(cmd, arg) {
  const o = arg && typeof arg === "object" ? arg : {};
  if (cmd === "start") return start(o);
  if (cmd === "status") {
    const rec = engines.get(String(o.id));
    return rec ? { ok: true, stats: stats(rec) } : { ok: false };
  }
  if (cmd === "collect") return collect(o);
  if (cmd === "stop") return stop(o);
  if (cmd === "point") return quietPoint();
  if (cmd === "top") {
    scrollTo({ top: 0, left: 0, behavior: "instant" });
    return pageInfo();
  }
  if (cmd === "page") return pageInfo();
  return { ok: false, error: "unknown command" };
}

window.__genclassScanVisual = scanVisual;
