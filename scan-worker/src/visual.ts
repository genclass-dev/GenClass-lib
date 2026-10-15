// The GenClass measured visual checks in the scanned page. The checks are the runtime's own lazy visual chunk
// (packages/runtime/dist/visual/index.js, branch wave2/visual), bundled with visual/scan-entry.js into
// src/visual-source.ts on CI (scripts/build-visual.sh, job scan-visual). This module only installs that script and
// calls it; the scan (src/scan.ts) runs it in Puppeteer's isolated world, so the page's scripts cannot see, replace
// or patch it.
//
// The script defines window.__genclassScanVisual(command, argument) while the installer runs. The installer takes it
// only when the script itself defined it (not a property the page had set up), moves it to a per-scan random,
// non-writable name, and deletes the well-known one. Commands (visual/scan-entry.js):
//   start   { id, mode: "observe" | "guard", fix, csp }  start an engine (guard + fix: the chunk's opt-in fixes)
//   status  { id }                                      passes, findings so far, elapsed time, visibility
//   collect { id, pass, passMs, skipHosts }             the first 40 findings as plain data (sanitized again here),
//                                                       every finding's identity (keys) and how many there were
//   stop    { id }                                      stop an engine; this undoes every fix it applied
//   net     { n }                                       the page's fetch/XHR requests in flight (the scanner counts)
//   point | top | page                                  a quiet point for wheel events; scroll to the top; page size

/** The installer: true when the visual checks are installed under `name` (also when they already were). */
export function installSource(name: string, visualSource: string): string {
  const n = JSON.stringify(name);
  return `(() => {
  if (Object.getOwnPropertyDescriptor(window, ${n})) return true;
  const free = (k) => { const d = Object.getOwnPropertyDescriptor(window, k); return !d || ("value" in d && d.writable && d.configurable); };
  let own = free("__genclassScanVisual");
  if (own) { try { delete window.__genclassScanVisual; } catch (e) { own = false; } }
  if (own) {
    try {
${visualSource}
    } catch (e) { own = false; }
  }
  const d = Object.getOwnPropertyDescriptor(window, "__genclassScanVisual");
  const fn = own && d && "value" in d && typeof d.value === "function" ? d.value : null;
  try { delete window.__genclassScanVisual; } catch (e) {}
  if (!fn) return false;
  Object.defineProperty(window, ${n}, { value: fn, writable: false, configurable: false, enumerable: false });
  return true; })()`;
}

/** One command to the installed checks; resolves with its result as a JSON string ("{}" when not installed). */
export function callSource(name: string, cmd: string, arg: Record<string, unknown> = {}): string {
  return `(async () => { const f = window[${JSON.stringify(name)}]; if (typeof f !== "function") return "{}"; return JSON.stringify(await f(${JSON.stringify(cmd)}, ${JSON.stringify(arg)})); })()`;
}

/** The @genclass/runtime version the race probe injects (the stable line; the probe is verified with it). */
export const RUNTIME_VERSION = "0.2.2";

/**
 * The released @genclass/runtime version that ships these visual checks and their fixes, or null while they are in
 * testing (branch wave2/visual; no published runtime has them: npm, main and release/0.3.0 have no visual code). Every
 * sentence on /scan and /scan/about, and every report, that says where the checks and fixes come from is built from
 * this, as the site's visual.json checks_in_runtime is. Set it only when that runtime is on npm.
 */
export const VISUAL_IN_RUNTIME: string | null = "0.3.0-beta.0";

/** The runtime the install line on /scan loads: the one with the visual checks when it is published, else the probe's. */
export const INSTALL_VERSION = VISUAL_IN_RUNTIME ?? RUNTIME_VERSION;
/** Whether that runtime is a pre-release (the page says so next to the install line). */
export const INSTALL_IS_BETA = /-/.test(INSTALL_VERSION);

/** Where the visual checks and fixes come from, in words: "in testing, not in runtime 0.2.1", or "in runtime 0.3.0". */
export function visualStatus(): { shipped: boolean; short: string; checks: string; fixes: string } {
  if (VISUAL_IN_RUNTIME)
    return {
      shipped: true,
      short: `in runtime ${VISUAL_IN_RUNTIME}`,
      checks: `the measured checks the GenClass runtime ships from version ${VISUAL_IN_RUNTIME}`,
      fixes: `the GenClass visual fixes (runtime ${VISUAL_IN_RUNTIME})`,
    };
  return {
    shipped: false,
    short: `in testing, not in runtime ${RUNTIME_VERSION}`,
    checks: `the measured checks built for the GenClass runtime (in testing; not in runtime ${RUNTIME_VERSION})`,
    fixes: `the GenClass visual fixes in testing (not in runtime ${RUNTIME_VERSION})`,
  };
}

/** The kinds the runtime can fix in the page (visual: { fix: true } in guard mode); everything else is reported only. */
export const FIX_KINDS = new Set(["text-invisible", "pointer-events-leak", "scroll-lock-stuck"]);
/** Fixes that the chunk's periodic read (every 2 s, two reads 1 s apart) applies and re-checks. */
export const PERIODIC_KINDS = new Set(["pointer-events-leak", "scroll-lock-stuck"]);

/** The identity of a visual finding inside one view: the same kind on the same selector in the same state. */
export const visualKey = (f: { kind: string; selector: string; detail?: Record<string, unknown> }): string =>
  `${f.kind}|${f.selector}|${String(f.detail?.state ?? "")}`;
