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
//   collect { id, pass, passMs, skipHosts }             the findings as plain data (sanitized again here)
//   stop    { id }                                      stop an engine; this undoes every fix it applied
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

/** The kinds the runtime can fix in the page (visual: { fix: true } in guard mode); everything else is reported only. */
export const FIX_KINDS = new Set(["text-invisible", "pointer-events-leak", "scroll-lock-stuck"]);
/** Fixes that the chunk's periodic read (every 2 s, two reads 1 s apart) applies and re-checks. */
export const PERIODIC_KINDS = new Set(["pointer-events-leak", "scroll-lock-stuck"]);

/** The identity of a visual finding inside one view: the same kind on the same selector in the same state. */
export const visualKey = (f: { kind: string; selector: string; detail?: Record<string, unknown> }): string =>
  `${f.kind}|${f.selector}|${String(f.detail?.state ?? "")}`;
