// Words for each kind of finding: its category and severity (which feed the score), what it is, why it matters and
// a suggested fix built from what was measured. The page shows these strings with textContent only.

import type { Category, Severity } from "./score.ts";

/** The GenClass visual checks' kinds (packages/runtime/src/visual, docs/runtime/VISUAL.md section 3). */
export const VISUAL_KINDS = [
  "image-broken",
  "image-css-broken",
  "media-failed",
  "stylesheet-failed",
  "font-failed",
  "icon-font-failed",
  "csp-blocked",
  "text-invisible",
  "text-template-leak",
  "text-placeholder",
  "text-encoding",
  "css-var-undefined",
  "image-distorted",
  "page-overflow-x",
  "viewport-meta-missing",
  "layout-shift",
  "page-blank",
  "click-blocked",
  "pointer-events-leak",
  "scroll-lock-stuck",
  "control-unreachable",
  "focus-obscured",
  "dialog-covered",
] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];
export type Kind = VisualKind | "duplicate-submit" | "genclass-detection";

export interface RawFinding {
  kind: Kind;
  /** Short CSS selector of the element, or "" when there is no element. */
  selector: string;
  /** Element box in document coordinates (CSS px), when there is one. */
  box?: { x: number; y: number; w: number; h: number } | null;
  /** What was measured, in a short phrase. */
  measured: string;
  detail?: Record<string, unknown>;
}

/**
 * Every kind: its score category, its default severity (a visual finding carries the severity the check measured,
 * which can differ: a broken image is high or medium), what it is and why it matters. The visual kinds' severities
 * are the check's own (VISUAL.md section 3).
 */
export const KINDS: Record<Kind, { category: Category; severity: Severity; what: string; why: string }> = {
  "text-invisible": {
    category: "readability",
    severity: "high",
    what: "Text that is almost invisible on its background",
    why: "Below 1.5:1 most people cannot read the text at all. Body text needs 4.5:1 to pass WCAG 2.2 (1.4.3).",
  },
  "text-template-leak": {
    category: "readability",
    severity: "high",
    what: "Template or debug text shows on the page",
    why: "A value was missing when the page rendered, so readers see [object Object], NaN or a raw placeholder instead of the content.",
  },
  "text-placeholder": {
    category: "readability",
    severity: "medium",
    what: "Placeholder content shows on the page",
    why: "Lorem ipsum or a placeholder image service usually means a section shipped before its real content.",
  },
  "text-encoding": {
    category: "readability",
    severity: "medium",
    what: "Characters are garbled",
    why: "Text decoded with the wrong character set, or escaped twice, shows symbols such as \u00c3\u00a9 or &amp; instead of the words.",
  },
  "font-failed": {
    category: "readability",
    severity: "low",
    what: "A web font failed to load",
    why: "The browser falls back to another font. Line lengths change and text can push the layout around.",
  },
  "icon-font-failed": {
    category: "readability",
    severity: "medium",
    what: "An icon font failed to load",
    why: "Icons show as empty boxes or as their names in words, so buttons that are only an icon lose their meaning.",
  },
  "image-broken": {
    category: "media",
    severity: "medium",
    what: "An image failed to load",
    why: "Visitors see an empty box or the alt text. If the image carries content, such as a product photo, that content is gone.",
  },
  "image-css-broken": {
    category: "media",
    severity: "medium",
    what: "A CSS background image failed to load",
    why: "The element shows only its background colour, so a section that relies on the picture looks empty.",
  },
  "media-failed": {
    category: "media",
    severity: "medium",
    what: "A video or audio element has nothing it can play",
    why: "Visitors see an empty or broken player where the page expects media.",
  },
  "image-distorted": {
    category: "media",
    severity: "medium",
    what: "An image is stretched or squashed",
    why: "It is drawn at a different shape than the file, so photos and logos look wrong.",
  },
  "stylesheet-failed": {
    category: "layout",
    severity: "high",
    what: "A stylesheet failed to load",
    why: "Everything that sheet styles falls back to browser defaults. Layout, spacing and navigation usually break.",
  },
  "csp-blocked": {
    category: "layout",
    severity: "medium",
    what: "The Content-Security-Policy blocked a file the page uses",
    why: "The browser refused a style, font, image or media file the page asks for, so that part shows unstyled or empty.",
  },
  "css-var-undefined": {
    category: "layout",
    severity: "low",
    what: "A CSS variable is used but defined nowhere",
    why: "The property falls back to its default, often a transparent colour or no spacing, so the element does not look as designed.",
  },
  "page-overflow-x": {
    category: "layout",
    severity: "high",
    what: "The page scrolls sideways",
    why: "Content past the right edge is easy to miss, and the page slides sideways while people scroll down.",
  },
  "viewport-meta-missing": {
    category: "layout",
    severity: "high",
    what: "Phones show the desktop layout, zoomed out",
    why: "Without a viewport meta tag a phone lays the page out 980 px wide and shrinks it, so text is tiny until people zoom in.",
  },
  "layout-shift": {
    category: "layout",
    severity: "medium",
    what: "Content jumps while the page loads",
    why: "A layout shift above 0.25 moves what people are about to read or tap.",
  },
  "page-blank": {
    category: "layout",
    severity: "high",
    what: "The main part of the page shows nothing",
    why: "No text or media rendered in the main region, so visitors see an empty page.",
  },
  "click-blocked": {
    category: "interaction",
    severity: "high",
    what: "An invisible layer swallows clicks",
    why: "Clicks meant for the control underneath land on a transparent layer and do nothing.",
  },
  "pointer-events-leak": {
    category: "interaction",
    severity: "high",
    what: "The whole page ignores clicks",
    why: "pointer-events: none was left on html or body, usually by a menu or dialog that closed without releasing it.",
  },
  "scroll-lock-stuck": {
    category: "interaction",
    severity: "high",
    what: "The page cannot scroll",
    why: "A scroll lock from a dialog or menu stayed on html or body after it closed, so visitors cannot reach the rest of the page.",
  },
  "control-unreachable": {
    category: "interaction",
    severity: "high",
    what: "A control is stuck under a fixed bar",
    why: "A fixed or sticky element covers it even at the end of the page, so it cannot be clicked or tapped.",
  },
  "focus-obscured": {
    category: "interaction",
    severity: "medium",
    what: "A focused element is hidden under a sticky bar",
    why: "Keyboard users cannot see where focus is (WCAG 2.2, 2.4.11).",
  },
  "dialog-covered": {
    category: "interaction",
    severity: "high",
    what: "An open dialog is covered, or its buttons are off-screen",
    why: "Visitors cannot reach the dialog's own controls, so they cannot finish it or close it.",
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
  const measured = f.detail?.severity;
  if (isVisual(f.kind) && (measured === "high" || measured === "medium" || measured === "low")) return measured;
  return KINDS[f.kind].severity;
}

const VISUAL_SET = new Set<string>(VISUAL_KINDS);
export const isVisual = (k: string): k is VisualKind => VISUAL_SET.has(k);

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

/** What to do when a visual check gave no CSS and no fix of its own. */
const GENERIC_FIX: Record<VisualKind, string> = {
  "image-broken": "Fix the image URL, or remove the image.",
  "image-css-broken": "Fix the background-image URL.",
  "media-failed": "Serve a source the browser can play (an MP4 with H.264 is the safe choice) and check its URL.",
  "stylesheet-failed": "Serve the stylesheet with status 200 and content-type text/css (check the build's hashed file name).",
  "font-failed": "Fix the font URL, and use font-display: swap with a fallback stack of similar metrics.",
  "icon-font-failed": "Fix the icon font's URL, or use inline SVG icons.",
  "csp-blocked": "Allow the file's origin in the matching Content-Security-Policy directive, or stop loading it.",
  "text-invisible": "Give the text a colour with at least 4.5:1 contrast on its background.",
  "text-template-leak": "Render a fallback when the value is missing, or keep the element hidden until its data has loaded.",
  "text-placeholder": "Replace the placeholder text or image with the real content.",
  "text-encoding": "Serve the page as UTF-8 (Content-Type: text/html; charset=utf-8) and escape text once.",
  "css-var-undefined": "Define the variable, or give var() a fallback value.",
  "image-distorted": "Set object-fit: cover (or contain), or give the image a height that matches its aspect ratio.",
  "page-overflow-x": "Find the element wider than the screen and give it max-width: 100%.",
  "viewport-meta-missing": 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head.',
  "layout-shift": "Reserve space for content that arrives late (width and height on images, min-height on slots for embeds and ads).",
  "page-blank": "Check the main region's render path: a failed data request, a script error or content left hidden.",
  "click-blocked": "Give the covering layer pointer-events: none, or remove it when it is not shown.",
  "pointer-events-leak": "Release pointer-events on every close path of the menu or dialog that set it.",
  "scroll-lock-stuck": "Remove the scroll lock on every close path of the dialog or menu that set it.",
  "control-unreachable": "Reserve space for the fixed element (padding at the end of the page), or move it on small screens.",
  "focus-obscured": "Set scroll-padding-top (or bottom) on html to the sticky element's height.",
  "dialog-covered": "Raise the dialog above the covering element, or let its content scroll inside the viewport.",
};

const sentence = (t: string): string => {
  const x = t.trim();
  return x ? `${x.charAt(0).toUpperCase()}${x.slice(1)}${/[.!?]$/.test(x) ? "" : "."}` : "";
};

/** The suggested fix for a finding: the check's own CSS and fix text when it gave them, else a fix for the kind. */
export function suggestFix(f: RawFinding): string {
  const d = f.detail ?? {};
  if (f.kind === "duplicate-submit")
    return "Disable the button while the request is in flight: form.addEventListener(\"submit\", (e) => { e.submitter && (e.submitter.disabled = true); }); and send an idempotency key so the server can drop a repeat.";
  if (f.kind === "genclass-detection") return (DIAGNOSIS_WORDS[diagnosisKey(f)] ?? DIAGNOSIS_WORDS.stale).fix;
  const css = typeof d.css === "string" ? d.css.trim() : "";
  const note = typeof d.cssNote === "string" ? d.cssNote.trim() : "";
  const text = typeof d.fixText === "string" ? sentence(d.fixText) : "";
  const parts = [css, note ? sentence(note) : "", text].filter(Boolean);
  return parts.length ? parts.join("\n") : GENERIC_FIX[f.kind];
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
/** Detail fields that hold a check's suggested CSS or fix in words: kept up to 600 characters, the rest 200. */
const LONG_DETAIL = new Set(["css", "cssNote", "fixText", "fixCss"]);

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
      else if (typeof val === "string") detail[k] = clamp(val, LONG_DETAIL.has(k) ? 600 : 200);
      else if (Array.isArray(val)) {
        detail[k] = val.slice(0, 8).filter((x) => (typeof x === "number" ? Number.isFinite(x) : typeof x === "string")).map((x) => (typeof x === "string" ? clamp(x, 200) : x));
      }
    }
  }
  return { kind: o.kind as Kind, selector: clamp(o.selector, 200), box, measured: clamp(o.measured, 240), detail };
}

/** The page statistics the checks return, numbers and one boolean only. */
export function sanitizeStats(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["docHeight", "docWidth", "ms", "passes", "elements", "partial", "abstained", "skipped"]) if (finite(o[k]) !== null) out[k] = o[k];
  if (Array.isArray(o.viewport) && o.viewport.length === 2 && o.viewport.every((x) => finite(x) !== null)) out.viewport = o.viewport;
  if (typeof o.viewportMeta === "boolean") out.viewportMeta = o.viewportMeta;
  return out;
}
