// Words for each kind of finding: its category and severity (which feed the score), what it is, why it matters and
// a suggested fix built from what was measured. The page shows these strings with textContent only.

import type { Category, Severity } from "./score.ts";

export type Kind =
  | "low-contrast"
  | "template-leak"
  | "failed-font"
  | "broken-image"
  | "failed-stylesheet"
  | "horizontal-overflow"
  | "covered-control"
  | "duplicate-submit"
  | "genclass-detection";

export interface RawFinding {
  kind: Kind;
  /** Short CSS selector of the element, or "" when there is no element (a stylesheet in <head>). */
  selector: string;
  /** Element box in document coordinates (CSS px), when there is one. */
  box?: { x: number; y: number; w: number; h: number } | null;
  /** What was measured, in a short phrase. */
  measured: string;
  detail?: Record<string, unknown>;
}

export const KINDS: Record<Kind, { category: Category; severity: Severity; what: string; why: string }> = {
  "low-contrast": {
    category: "readability",
    severity: "high",
    what: "Text that is almost invisible on its background",
    why: "Below 1.5:1 most people cannot read the text at all. Body text needs 4.5:1 to pass WCAG 2.2 (1.4.3).",
  },
  "template-leak": {
    category: "readability",
    severity: "high",
    what: "Template or debug text shows on the page",
    why: "A value was missing when the page rendered, so readers see placeholder text instead of the content.",
  },
  "failed-font": {
    category: "readability",
    severity: "low",
    what: "A web font failed to load",
    why: "The browser falls back to another font. Line lengths change and text can push the layout around.",
  },
  "broken-image": {
    category: "media",
    severity: "medium",
    what: "An image failed to load",
    why: "Visitors see an empty box or the alt text. If the image carries content, such as a product photo, that content is gone.",
  },
  "failed-stylesheet": {
    category: "layout",
    severity: "high",
    what: "A stylesheet failed to load",
    why: "Everything that sheet styles falls back to browser defaults. Layout, spacing and navigation usually break.",
  },
  "horizontal-overflow": {
    category: "layout",
    severity: "high",
    what: "The page scrolls sideways on a phone",
    why: "Content past the right edge is easy to miss, and the page slides sideways while people scroll down.",
  },
  "covered-control": {
    category: "interaction",
    severity: "medium",
    what: "A control is covered by another element",
    why: "A tap or click at the control's centre lands on the element on top, so the control does nothing.",
  },
  "duplicate-submit": {
    category: "interaction",
    severity: "high",
    what: "A double click sent the same request twice",
    why: "People double-click. A second identical request can mean a second order, sign-up or payment.",
  },
  "genclass-detection": {
    category: "interaction",
    severity: "high",
    what: "GenClass flagged a timing problem",
    why: "The page acted on a response in a way that GenClass's model diagnosed as a bug.",
  },
};

/** A GET or HEAD subject ("GET /api/me (#3)", "response to GET /api/search?q=a (#7)"): repeating it changes nothing on the server. */
const SAFE_SUBJECT = /^(?:response to )?(?:GET|HEAD)\s/i;
const safeSubject = (f: RawFinding): boolean => SAFE_SUBJECT.test(String(f.detail?.subject ?? f.selector ?? ""));

/**
 * The severity of one finding: its kind's, except a GenClass "duplicate" on a GET or HEAD, which repeats a read and
 * creates nothing, so it counts as low.
 */
export function severityOf(f: RawFinding): Severity {
  if (f.kind === "genclass-detection" && String(f.detail?.diagnosis) === "duplicate" && safeSubject(f)) return "low";
  return KINDS[f.kind].severity;
}

const DIAGNOSIS_WORDS: Record<string, { what: string; why: string; fix: string }> = {
  stale: {
    what: "A response landed over newer data",
    why: "An older response replaced newer state, so the page shows results for something the visitor no longer asked for.",
    fix: "Keep only the latest request's answer: abort the previous fetch (an AbortController per query), or compare a request counter before you set state.",
  },
  duplicate: {
    what: "The same request ran twice without a new intent",
    why: "Repeated requests can create duplicate records and double the load on the server.",
    fix: "Disable the control while its request is in flight, or send an idempotency key with the request.",
  },
  "duplicate-read": {
    what: "The same data was fetched twice without a new intent",
    why: "A repeated GET changes nothing on the server, but it doubles the load and the page renders the same data twice.",
    fix: "Share one in-flight request between the parts of the page that need it, for example a request cache or one loader that both components read.",
  },
  conflict: {
    what: "Two operations competed over the same state",
    why: "Whichever finishes last wins, so the result depends on network timing.",
    fix: "Serialise the two writes (queue them) or merge them on the server.",
  },
  inconsistent: {
    what: "The page's state contradicts itself",
    why: "Two parts of the page now disagree, which visitors notice as wrong totals or counts.",
    fix: "Derive the dependent value from one source of truth instead of storing it twice.",
  },
  failing: {
    what: "A request kept failing",
    why: "Repeated failures usually mean a broken endpoint that the page retries without telling the visitor.",
    fix: "Show an error state and back off between retries.",
  },
};

// --------------------------------------------------------------------------------------------- colour helpers

export function hex(rgb: readonly number[]): string {
  return `#${rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function luminance(rgb: readonly number[]): number {
  const ch = rgb.slice(0, 3).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: readonly number[], b: readonly number[]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const round2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/** The suggested fix for a finding, from what was measured. CSS where CSS fixes it; code otherwise. */
export function suggestFix(f: RawFinding): string {
  const sel = f.selector || "selector";
  const d = f.detail ?? {};
  switch (f.kind) {
    case "low-contrast": {
      const bg = Array.isArray(d.bg) ? (d.bg as number[]) : [255, 255, 255];
      const ink = luminance(bg) > 0.18 ? [26, 26, 26] : [245, 245, 245];
      return `${sel} { color: ${hex(ink).toLowerCase()}; } /* ${round2(contrast(ink, bg))}:1 on ${hex(bg).toLowerCase()} */`;
    }
    case "template-leak":
      return `Render a fallback when the value is missing (for example {price ?? "Price on request"}), or keep the element hidden until its data has loaded: ${sel}:empty { display: none; }`;
    case "failed-font":
      return `@font-face { font-display: swap; } and a fallback stack with similar metrics: font-family: ${String(d.family || "YourFont")}, system-ui, sans-serif; then fix the font URL.`;
    case "broken-image":
      return `Fix the image URL. Until then, keep the space readable: ${sel} { color: #4a4a4a; font: 14px/1.4 system-ui, sans-serif; } so the alt text shows instead of a broken icon.`;
    case "failed-stylesheet":
      return `Serve ${String(d.url || "the stylesheet")} with status 200 and content-type text/css (check the build's hashed file name), and inline the CSS the first screen needs.`;
    case "horizontal-overflow": {
      const tag = String(d.tag || "");
      if (/^(img|video|iframe|canvas|svg|picture)$/.test(tag)) return `${sel} { max-width: 100%; height: auto; }`;
      if (/^(pre|table|code)$/.test(tag)) return `${sel} { max-width: 100%; overflow-x: auto; }`;
      return `${sel} { max-width: 100%; overflow-wrap: anywhere; } /* or find the fixed width that is wider than ${String(d.viewport || 390)} px */`;
    }
    case "covered-control":
      return `${String(d.cover || "the covering element")} { pointer-events: none; } if that layer is decorative; otherwise move it below the control with a lower z-index.`;
    case "duplicate-submit":
      return "Disable the button while the request is in flight: form.addEventListener(\"submit\", (e) => { e.submitter && (e.submitter.disabled = true); }); and send an idempotency key so the server can drop a repeat.";
    case "genclass-detection":
      return (DIAGNOSIS_WORDS[diagnosisKey(f)] ?? DIAGNOSIS_WORDS.stale).fix;
  }
}

/** The words to use for a GenClass detection: its diagnosis, with a duplicate GET kept apart from a duplicate write. */
function diagnosisKey(f: RawFinding): string {
  const d = String(f.detail?.diagnosis);
  return d === "duplicate" && safeSubject(f) ? "duplicate-read" : d;
}

/** The headline and the reason for a finding (a GenClass detection uses the words for its diagnosis). */
export function describe(f: RawFinding): { what: string; why: string } {
  if (f.kind === "genclass-detection") {
    const w = Object.hasOwn(DIAGNOSIS_WORDS, diagnosisKey(f)) ? DIAGNOSIS_WORDS[diagnosisKey(f)] : null;
    if (w) return { what: w.what, why: w.why };
  }
  return { what: KINDS[f.kind].what, why: KINDS[f.kind].why };
}

// ------------------------------------------------------------------------------------- data from the page

const clamp = (v: unknown, n: number): string => {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.length > n ? s.slice(0, n) : s;
};
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A finding as returned by code running in the scanned page, made safe to store and show on genclass.dev: a kind the
 * catalog knows (own properties only), strings cut to 200 characters, a numeric box, and a detail object of short
 * primitives and small arrays. Null when it is not a finding.
 */
export function sanitizeFinding(v: unknown): RawFinding | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== "string" || !Object.hasOwn(KINDS, o.kind)) return null;
  let box: RawFinding["box"] = null;
  if (o.box && typeof o.box === "object") {
    const b = o.box as Record<string, unknown>;
    const [x, y, w, h] = [finite(b.x), finite(b.y), finite(b.w), finite(b.h)];
    if (x !== null && y !== null && w !== null && h !== null && w >= 0 && h >= 0) box = { x, y, w, h };
  }
  const detail: Record<string, unknown> = {};
  if (o.detail && typeof o.detail === "object" && !Array.isArray(o.detail)) {
    for (const [k, val] of Object.entries(o.detail as Record<string, unknown>).slice(0, 16)) {
      if (!/^[A-Za-z][\w-]{0,30}$/.test(k)) continue;
      if (typeof val === "number") {
        if (Number.isFinite(val)) detail[k] = val;
      } else if (typeof val === "boolean") detail[k] = val;
      else if (typeof val === "string") detail[k] = clamp(val, 200);
      else if (Array.isArray(val)) {
        detail[k] = val.slice(0, 8).filter((x) => (typeof x === "number" ? Number.isFinite(x) : typeof x === "string")).map((x) => (typeof x === "string" ? clamp(x, 200) : x));
      }
    }
  }
  return { kind: o.kind as Kind, selector: clamp(o.selector, 200), box, measured: clamp(o.measured, 240), detail };
}

/** Notes the scanner's own checks write: kept only when they look like one (short, plain characters, at most four). */
export function sanitizeNotes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is string => typeof n === "string" && n.length > 0 && n.length <= 200 && /^[\w\s.,;:()%'\/#=-]+$/.test(n)).slice(0, 4);
}

/** The page statistics the checks return, numbers and one boolean only. */
export function sanitizeStats(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["textChecked", "textElements", "textOutsideCapture", "docHeight", "docWidth", "ms"]) if (finite(o[k]) !== null) out[k] = o[k];
  if (Array.isArray(o.viewport) && o.viewport.length === 2 && o.viewport.every((x) => finite(x) !== null)) out.viewport = o.viewport;
  if (typeof o.viewportMeta === "boolean") out.viewportMeta = o.viewportMeta;
  if (o.contrastSkipped && typeof o.contrastSkipped === "object" && !Array.isArray(o.contrastSkipped)) {
    const skips: Record<string, number> = {};
    for (const [k, n] of Object.entries(o.contrastSkipped as Record<string, unknown>).slice(0, 12)) if (/^[\w-]{1,30}$/.test(k) && finite(n) !== null) skips[k] = n as number;
    out.contrastSkipped = skips;
  }
  return out;
}
