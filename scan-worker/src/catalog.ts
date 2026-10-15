// Words for each kind of finding: its score category and default severity, what it is, why it matters, the standard
// or measurement it is judged by, and a suggested fix built from what was measured. The page shows these strings with
// textContent only.

import { JUDGE_FIX, JUDGE_WHAT, JUDGE_WHY } from "./judge.ts";
import type { Category, Severity } from "./score.ts";
import { isWcagRule, scFromTags, STANDARDS, wcag, type Standard } from "./standards.ts";

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
/** Kinds the page check cannot see: click-blocked needs a visitor's clicks, and the scanner clicks only the probe's button. */
export const NOT_RUN_HERE = new Set<VisualKind>(["click-blocked"]);

/** The scanner's own audits, measured in the page (src/audits.ts) or from the browser's DevTools protocol (src/cdp.ts). */
export const AUDIT_KINDS = [
  "tap-target-small",
  "zoom-disabled",
  "font-size-small",
  "reflow-overflow",
  "image-oversized",
  "image-unsized-shift",
  "lcp-slow",
  "cls-high",
  "js-heavy",
  "js-error",
  "console-error",
  "request-failed",
  "mixed-content",
  // scan-score/4: keyboard, tablet, best practices, speed, security headers, search and sharing
  "focus-invisible",
  "skip-link-missing",
  "tablet-overflow",
  "deprecated-api",
  "quirks-mode",
  "page-weight",
  "image-format",
  "font-display",
  "https-missing",
  "http-no-redirect",
  "hsts-missing",
  "csp-missing",
  "nosniff-missing",
  "clickjack-unprotected",
  "cookie-insecure",
  "meta-description-missing",
  "noindex",
  "social-preview-missing",
  "favicon-missing",
  "link-text-generic",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
/** "axe" is one axe-core rule's violations in one view; the rule id is detail.rule. */
export type Kind = VisualKind | AuditKind | "axe" | "duplicate-submit" | "genclass-detection" | "visual-judged";

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
 * Which part of the scanner found a kind: the GenClass visual checks, axe-core, the scanner's audits, the race probe
 * (all measured), or the model judge (src/judge.ts: judged from the screenshot by a model, never measured).
 */
export type Source = "visual" | "axe" | "audit" | "probe" | "judge";

/**
 * Every kind: its score category, its default severity, what it is, why it matters, the standard it is judged by (when
 * there is one beyond the measurement itself) and which part of the scanner measures it. A visual finding carries the
 * severity its check measured (VISUAL.md section 3: high, medium, low), read as serious, moderate and minor; a blank page,
 * a page that ignores clicks and a page that cannot scroll are critical. An audit or axe-core finding carries its own.
 */
export const KINDS: Record<Kind, { category: Category; severity: Severity; what: string; why: string; standard?: Standard; source: Source }> = {
  "text-invisible": {
    category: "visual",
    severity: "serious",
    what: "Text that is almost invisible on its background",
    why: "Below 1.5:1 most people cannot read the text at all. Body text needs 4.5:1.",
    standard: wcag("1.4.3"),
    source: "visual",
  },
  "text-template-leak": {
    category: "visual",
    severity: "serious",
    what: "Template or debug text shows on the page",
    why: "A value was missing when the page rendered, so readers see [object Object], NaN or a raw placeholder instead of the content.",
    source: "visual",
  },
  "text-placeholder": {
    category: "visual",
    severity: "moderate",
    what: "Placeholder content shows on the page",
    why: "Lorem ipsum or a placeholder image service usually means a section shipped before its real content.",
    source: "visual",
  },
  "text-encoding": {
    category: "visual",
    severity: "moderate",
    what: "Characters are garbled",
    why: "Text decoded with the wrong character set, or escaped twice, shows symbols such as Ã© or &amp; instead of the words.",
    source: "visual",
  },
  "font-failed": {
    category: "visual",
    severity: "minor",
    what: "A web font failed to load",
    why: "The browser falls back to another font. Line lengths change and text can push the layout around.",
    source: "visual",
  },
  "icon-font-failed": {
    category: "visual",
    severity: "moderate",
    what: "An icon font failed to load",
    why: "Icons show as empty boxes or as their names in words, so buttons that are only an icon lose their meaning.",
    source: "visual",
  },
  "image-broken": {
    category: "visual",
    severity: "moderate",
    what: "An image failed to load",
    why: "Visitors see an empty box or the alt text. If the image carries content, such as a product photo, that content is gone.",
    source: "visual",
  },
  "image-css-broken": {
    category: "visual",
    severity: "moderate",
    what: "A CSS background image failed to load",
    why: "The element shows only its background colour, so a section that relies on the picture looks empty.",
    source: "visual",
  },
  "media-failed": {
    category: "visual",
    severity: "moderate",
    what: "A video or audio element has nothing it can play",
    why: "Visitors see an empty or broken player where the page expects media.",
    source: "visual",
  },
  "image-distorted": {
    category: "visual",
    severity: "moderate",
    what: "An image is stretched or squashed",
    why: "It is drawn at a different shape than the file, so photos and logos look wrong.",
    source: "visual",
  },
  "stylesheet-failed": {
    category: "visual",
    severity: "serious",
    what: "A stylesheet failed to load",
    why: "Everything that sheet styles falls back to browser defaults. Layout, spacing and navigation usually break.",
    source: "visual",
  },
  "csp-blocked": {
    category: "visual",
    severity: "moderate",
    what: "The Content-Security-Policy blocked a file the page uses",
    why: "The browser refused a style, font, image or media file the page asks for, so that part shows unstyled or empty.",
    source: "visual",
  },
  "css-var-undefined": {
    category: "visual",
    severity: "minor",
    what: "A CSS variable is used but defined nowhere",
    why: "The property falls back to its default, often a transparent colour or no spacing, so the element does not look as designed.",
    source: "visual",
  },
  "page-overflow-x": {
    category: "phone",
    severity: "serious",
    what: "The page scrolls sideways",
    why: "Content past the right edge is easy to miss, and the page slides sideways while people scroll down.",
    standard: wcag("1.4.10"),
    source: "visual",
  },
  "viewport-meta-missing": {
    category: "phone",
    severity: "serious",
    what: "Phones show the desktop layout, zoomed out",
    why: "Without a viewport meta tag a phone lays the page out 980 px wide and shrinks it, so text is tiny until people zoom in.",
    standard: STANDARDS.viewport,
    source: "visual",
  },
  "layout-shift": {
    category: "speed",
    severity: "moderate",
    what: "Content jumps while the page loads",
    why: "A layout shift above 0.25 moves what people are about to read or tap.",
    standard: STANDARDS.cls,
    source: "visual",
  },
  "page-blank": {
    category: "visual",
    severity: "critical",
    what: "The main part of the page shows nothing",
    why: "No text or media rendered in the main region, so visitors see an empty page.",
    source: "visual",
  },
  "click-blocked": {
    category: "visual",
    severity: "serious",
    what: "An invisible layer swallows clicks",
    why: "Clicks meant for the control underneath land on a transparent layer and do nothing.",
    source: "visual",
  },
  "pointer-events-leak": {
    category: "visual",
    severity: "critical",
    what: "The whole page ignores clicks",
    why: "pointer-events: none was left on html or body, usually by a menu or dialog that closed without releasing it.",
    source: "visual",
  },
  "scroll-lock-stuck": {
    category: "visual",
    severity: "critical",
    what: "The page cannot scroll",
    why: "A scroll lock from a dialog or menu stayed on html or body after it closed, so visitors cannot reach the rest of the page.",
    source: "visual",
  },
  "control-unreachable": {
    category: "visual",
    severity: "serious",
    what: "A control is stuck under a fixed bar",
    why: "A fixed or sticky element covers it even at the end of the page, so it cannot be clicked or tapped.",
    source: "visual",
  },
  "focus-obscured": {
    category: "accessibility",
    severity: "moderate",
    what: "A focused element is hidden under a sticky bar",
    why: "Keyboard users cannot see where focus is.",
    standard: wcag("2.4.11"),
    source: "visual",
  },
  "dialog-covered": {
    category: "visual",
    severity: "serious",
    what: "An open dialog is covered, or its buttons are off-screen",
    why: "Visitors cannot reach the dialog's own controls, so they cannot finish it or close it.",
    source: "visual",
  },
  axe: {
    category: "accessibility",
    severity: "moderate",
    what: "An accessibility rule failed",
    why: "axe-core found elements that fail this rule.",
    source: "axe",
  },
  "tap-target-small": {
    category: "phone",
    severity: "serious",
    what: "Tap targets smaller than 24 by 24 px, too close to other targets",
    why: "Small targets next to other targets are easy to miss or mis-tap, for everyone and most of all for people with tremors or large fingers.",
    standard: wcag("2.5.8"),
    source: "audit",
  },
  "zoom-disabled": {
    category: "phone",
    severity: "serious",
    what: "Pinch zoom is turned off",
    why: "The viewport meta tag stops people from zooming in to read. Chrome on Android honours it; Safari on iOS ignores it.",
    standard: wcag("1.4.4"),
    source: "audit",
  },
  "font-size-small": {
    category: "phone",
    severity: "minor",
    what: "Body text smaller than 12 px on a phone",
    why: "Text under 12 px is hard to read on a phone without zooming in.",
    standard: STANDARDS.fontSize,
    source: "audit",
  },
  "reflow-overflow": {
    category: "phone",
    severity: "serious",
    what: "The page scrolls sideways on narrower phones",
    why: "At 360 or 320 px wide the content no longer fits and the page scrolls in two directions. Many Android phones are 360 px wide, and 320 px is the width WCAG's reflow criterion uses (a 1280 px window at 400% zoom).",
    standard: wcag("1.4.10"),
    source: "audit",
  },
  "image-oversized": {
    category: "speed",
    severity: "minor",
    what: "Images far bigger than they are shown",
    why: "The browser downloads and decodes pixels nobody sees, which slows the page down, most of all on a phone connection.",
    standard: STANDARDS.oversized,
    source: "audit",
  },
  "image-unsized-shift": {
    category: "speed",
    severity: "minor",
    what: "An image without dimensions moved the content below it",
    why: "With no width and height (or aspect-ratio) the browser cannot reserve the image's space, so the page jumps when the file arrives.",
    standard: STANDARDS.unsized,
    source: "audit",
  },
  "lcp-slow": {
    category: "speed",
    severity: "moderate",
    what: "The largest content appears late",
    why: "Largest Contentful Paint is when the main content shows. web.dev rates it good up to 2.5 s and poor above 4 s.",
    standard: STANDARDS.lcp,
    source: "audit",
  },
  "cls-high": {
    category: "speed",
    severity: "moderate",
    what: "The layout shifts while the page loads",
    why: "Content that moves while people read or reach for it causes mis-taps and lost place. web.dev rates it good up to 0.1 and poor above 0.25.",
    standard: STANDARDS.cls,
    source: "audit",
  },
  "js-heavy": {
    category: "speed",
    severity: "minor",
    what: "More than 1 MB of JavaScript transferred",
    why: "Every script has to download, parse and run before the page responds, which is slow on mid-range phones.",
    standard: STANDARDS.jsBytes,
    source: "audit",
  },
  "js-error": {
    category: "reliability",
    severity: "moderate",
    what: "Uncaught JavaScript errors while the page loads",
    why: "An uncaught error stops the code that threw it, so whatever it was setting up (a menu, a form, a widget) can be missing or half-built.",
    standard: STANDARDS.consoleErrors,
    source: "audit",
  },
  "console-error": {
    category: "reliability",
    severity: "minor",
    what: "console.error while the page loads",
    why: "Code on the page reported an error. It often points at a failed request or a broken integration.",
    standard: STANDARDS.consoleErrors,
    source: "audit",
  },
  "request-failed": {
    category: "reliability",
    severity: "moderate",
    what: "Same-site requests that failed",
    why: "The page asked its own site for scripts or data and the server answered with an error, so whatever needed them is missing.",
    standard: STANDARDS.httpStatus,
    source: "audit",
  },
  "mixed-content": {
    category: "reliability",
    severity: "moderate",
    what: "The secure page asks for files over plain http",
    why: "Browsers block scripts, frames and data requests sent over http from an https page, and upgrade or block images and media.",
    standard: STANDARDS.mixedContent,
    source: "audit",
  },
  "focus-invisible": {
    category: "accessibility",
    severity: "serious",
    what: "Elements show no visible focus",
    why: "Keyboard users cannot see which link or button they are on.",
    standard: wcag("2.4.7"),
    source: "audit",
  },
  "skip-link-missing": {
    category: "accessibility",
    severity: "minor",
    what: "No skip link before a long run of links",
    why: "Keyboard users must Tab through every header link before they reach the content.",
    standard: STANDARDS.skipLink,
    source: "audit",
  },
  "tablet-overflow": {
    category: "phone",
    severity: "moderate",
    what: "The page scrolls sideways on a tablet",
    why: "At 768 px wide (a tablet held upright) content sticks out past the right edge.",
    source: "audit",
  },
  "deprecated-api": {
    category: "reliability",
    severity: "minor",
    what: "Uses browser features Chrome is removing",
    why: "Chrome reported deprecated APIs on this page; they stop working in a future version.",
    standard: STANDARDS.deprecations,
    source: "audit",
  },
  "quirks-mode": {
    category: "reliability",
    severity: "minor",
    what: "The page renders in quirks mode",
    why: "Without <!doctype html> browsers emulate old layout bugs, so sizes and spacing differ from the standard.",
    standard: STANDARDS.doctype,
    source: "audit",
  },
  "page-weight": {
    category: "speed",
    severity: "minor",
    what: "The page downloads a lot of data",
    why: "Every megabyte costs seconds and money on a phone connection.",
    standard: STANDARDS.byteWeight,
    source: "audit",
  },
  "image-format": {
    category: "speed",
    severity: "minor",
    what: "Large images in JPEG, PNG, GIF or BMP",
    why: "Every current browser takes WebP and AVIF, which usually make the same picture 25 to 50% smaller.",
    standard: STANDARDS.imageFormats,
    source: "audit",
  },
  "font-display": {
    category: "speed",
    severity: "minor",
    what: "Web fonts without font-display",
    why: "Text in these fonts stays invisible until the font arrives (up to 3 s).",
    standard: STANDARDS.fontDisplay,
    source: "audit",
  },
  "https-missing": {
    category: "security",
    severity: "serious",
    what: "The page is not served over HTTPS",
    why: "Anyone on the network can read and change it, and browsers mark it Not secure.",
    standard: STANDARDS.https,
    source: "audit",
  },
  "http-no-redirect": {
    category: "security",
    severity: "moderate",
    what: "http:// does not redirect to https://",
    why: "Anyone who reaches the http:// address (an old link, an app, a browser that does not upgrade it) stays on an unencrypted page.",
    standard: STANDARDS.tls,
    source: "audit",
  },
  "hsts-missing": {
    category: "security",
    severity: "moderate",
    what: "No Strict-Transport-Security header",
    why: "Without HSTS, a visit that starts on http:// can be intercepted before the redirect to https://.",
    standard: STANDARDS.hsts,
    source: "audit",
  },
  "csp-missing": {
    category: "security",
    severity: "moderate",
    what: "No Content-Security-Policy limiting scripts",
    why: "A CSP decides which scripts may run, so an injected script (XSS) is blocked.",
    standard: STANDARDS.csp,
    source: "audit",
  },
  "nosniff-missing": {
    category: "security",
    severity: "minor",
    what: "No X-Content-Type-Options: nosniff",
    why: "Browsers may guess a file's type and run a file served as text as a script.",
    standard: STANDARDS.headers,
    source: "audit",
  },
  "clickjack-unprotected": {
    category: "security",
    severity: "moderate",
    what: "Any site can show this page in a frame",
    why: "Another site can load it in an invisible frame and trick visitors into clicking it (clickjacking).",
    standard: STANDARDS.clickjacking,
    source: "audit",
  },
  "cookie-insecure": {
    category: "security",
    severity: "moderate",
    what: "Cookies set without Secure or HttpOnly",
    why: "A cookie without Secure can travel over plain http; a session cookie without HttpOnly can be read by an injected script.",
    standard: STANDARDS.cookies,
    source: "audit",
  },
  "meta-description-missing": {
    category: "seo",
    severity: "moderate",
    what: "No meta description",
    why: "Search results then show a snippet the search engine picks from the page.",
    standard: STANDARDS.metaDescription,
    source: "audit",
  },
  noindex: {
    category: "seo",
    severity: "serious",
    what: "Search engines are told not to list this page",
    why: "A noindex robots meta tag or X-Robots-Tag header keeps the page out of search results.",
    standard: STANDARDS.crawlable,
    source: "audit",
  },
  "social-preview-missing": {
    category: "seo",
    severity: "minor",
    what: "No link preview title or image",
    why: "Links shared in chats and social apps show without a picture or a proper title.",
    standard: STANDARDS.openGraph,
    source: "audit",
  },
  "favicon-missing": {
    category: "seo",
    severity: "minor",
    what: "No favicon",
    why: "Tabs, bookmarks and search results show a blank icon.",
    standard: STANDARDS.favicon,
    source: "audit",
  },
  "link-text-generic": {
    category: "seo",
    severity: "minor",
    what: "Links that only say \"learn more\" or \"click here\"",
    why: "Search engines and screen reader users cannot tell where the link goes.",
    standard: STANDARDS.linkText,
    source: "audit",
  },
  "duplicate-submit": {
    category: "races",
    severity: "serious",
    what: "A double click sent the same request twice",
    why: "People double-click. A second identical request can mean a second order, sign-up or payment.",
    source: "probe",
  },
  "genclass-detection": {
    category: "races",
    severity: "serious",
    what: "GenClass flagged a timing problem",
    why: "The page acted on a response in a way that GenClass's model diagnosed as a bug.",
    source: "probe",
  },
  "visual-judged": {
    category: "visual",
    severity: "moderate",
    what: "An element that looks broken in the screenshot",
    why: JUDGE_WHY,
    source: "judge",
  },
};

const SEVERITIES = new Set<string>(["critical", "serious", "moderate", "minor"]);
export const isSeverity = (v: unknown): v is Severity => typeof v === "string" && SEVERITIES.has(v);

/** A GET or HEAD subject ("GET /api/me (#3)", "response to GET /api/search?q=a (#7)"): repeating it changes nothing on the server. */
const SAFE_SUBJECT = /^(?:response to )?(?:GET|HEAD)\s/i;
const safeSubject = (f: RawFinding): boolean => SAFE_SUBJECT.test(String(f.detail?.subject ?? f.selector ?? ""));

/** The visual checks' own severities, read on the four-level scale. */
const VISUAL_SEVERITY: Record<string, Severity> = { high: "serious", medium: "moderate", low: "minor" };
/** Visual kinds that make the whole page unusable: critical when the check measured them as high. */
const CRITICAL_VISUAL = new Set<Kind>(["page-blank", "pointer-events-leak", "scroll-lock-stuck"]);

/**
 * The severity of one finding. A visual finding: the check's measured severity on the four-level scale (critical for
 * the kinds that make the whole page unusable). An axe-core or audit finding: the severity it carries. A GenClass
 * "duplicate" on a GET or HEAD repeats a read and creates nothing, so it is minor. Otherwise the kind's default.
 */
export function severityOf(f: RawFinding): Severity {
  if (f.kind === "genclass-detection" && String(f.detail?.diagnosis) === "duplicate" && safeSubject(f)) return "minor";
  const measured = f.detail?.severity;
  if (isVisual(f.kind)) {
    const s = typeof measured === "string" && Object.hasOwn(VISUAL_SEVERITY, measured) ? VISUAL_SEVERITY[measured] : null;
    if (s) return s === "serious" && CRITICAL_VISUAL.has(f.kind) ? "critical" : s;
    return KINDS[f.kind].severity;
  }
  if ((f.kind === "axe" || isAudit(f.kind)) && isSeverity(measured)) return measured;
  return KINDS[f.kind].severity;
}

/** A finding's category: its kind's, except sideways scrolling seen on the desktop only, which is a visual bug. */
export function categoryOf(kind: Kind, views: readonly string[]): Category {
  if (kind === "page-overflow-x" && !views.some((v) => v === "phone" || v === "phone-dark")) return "visual";
  return KINDS[kind].category;
}

/** The rule a finding belongs to, for grouping and the score: its kind, or the axe-core rule id. */
export function ruleOf(f: RawFinding): string {
  return f.kind === "axe" ? `axe:${String(f.detail?.rule ?? "")}` : f.kind;
}

const VISUAL_SET = new Set<string>(VISUAL_KINDS);
const AUDIT_SET = new Set<string>(AUDIT_KINDS);
export const isVisual = (k: string): k is VisualKind => VISUAL_SET.has(k);
export const isAudit = (k: string): k is AuditKind => AUDIT_SET.has(k);

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The standards a finding is judged by: for an axe-core rule, the WCAG 2.2 success criteria its tags name (or "axe-core
 * best practice" for a rule outside WCAG); for any other kind, its catalog standard. Empty when the measurement itself is
 * the evidence (a file that failed to load).
 */
export function standardsOf(f: RawFinding): Standard[] {
  if (f.kind === "axe") {
    const tags = strings(f.detail?.tags);
    const scs = scFromTags(tags);
    return isWcagRule(tags) && scs.length ? scs.map(wcag) : [STANDARDS.axeBestPractice];
  }
  const s = KINDS[f.kind].standard;
  return s ? [s] : [];
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

/** What to do when a check gave no CSS and no fix of its own. */
const GENERIC_FIX: Record<Exclude<Kind, "axe" | "duplicate-submit" | "genclass-detection" | "visual-judged">, string> = {
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
  "page-overflow-x": "Find the element wider than the screen and give it max-width: 100%; when it sits in a flex or grid row, also give it min-width: 0 so it can shrink.",
  "viewport-meta-missing": 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head.',
  "layout-shift": "Reserve space for content that arrives late (width and height on images, min-height on slots for embeds and ads).",
  "page-blank": "Check the main region's render path: a failed data request, a script error or content left hidden.",
  "click-blocked": "Give the covering layer pointer-events: none, or remove it when it is not shown.",
  "pointer-events-leak": "Release pointer-events on every close path of the menu or dialog that set it.",
  "scroll-lock-stuck": "Remove the scroll lock on every close path of the dialog or menu that set it.",
  "control-unreachable": "Reserve space for the fixed element (padding at the end of the page), or move it on small screens.",
  "focus-obscured": "Set scroll-padding-top (or bottom) on html to the sticky element's height.",
  "dialog-covered": "Raise the dialog above the covering element, or let its content scroll inside the viewport.",
  "tap-target-small": "Make each target at least 24 by 24 px (padding counts, for example a { display: inline-block; padding: 4px 0; min-height: 24px; }), or keep 24 px between the centres of small targets.",
  "zoom-disabled": 'Remove user-scalable=no and maximum-scale from the viewport meta tag: <meta name="viewport" content="width=device-width, initial-scale=1">.',
  "font-size-small": "Set body text to at least 12 px on small screens (16 px is the common default), for example @media (max-width: 480px) { footer, .legal { font-size: 12px; } }.",
  "reflow-overflow": "Find the element wider than the screen and give it max-width: 100%; when it sits in a flex or grid row, also give it min-width: 0 so it can shrink, and let long words wrap (overflow-wrap: anywhere).",
  "image-oversized": "Serve each image near the size it is shown: srcset with widths and a sizes attribute, or an image CDN's resize parameters.",
  "image-unsized-shift": 'Give the image width and height attributes that match the file (<img width="1200" height="800">), or CSS aspect-ratio, so its space is reserved before it loads.',
  "lcp-slow": "Make the largest element arrive sooner: preload the hero image (fetchpriority=\"high\"), do not lazy-load it, and serve it small and from the same origin or a fast CDN.",
  "cls-high": "Reserve space for content that arrives late: width and height on images and video, min-height on slots for embeds, ads and banners, and font-display: optional or matched fallback fonts.",
  "js-heavy": "Split the bundle by route, load third-party scripts after the page is interactive, and remove code the page does not use.",
  "js-error": "Open the browser console on this page and fix the first uncaught error: each one stops the code that threw it.",
  "console-error": "Look at what the page logs with console.error while it loads and fix the cause, or stop logging expected conditions as errors.",
  "request-failed": "Fix or remove each failing URL: a script or chunk that answers 404 usually means a stale build reference, a 5xx a broken endpoint.",
  "mixed-content": "Load every file over https (change http:// to https:// or to a relative URL), and add Content-Security-Policy: upgrade-insecure-requests.",
  "focus-invisible": "Give every link, button and control a visible :focus-visible style, for example :focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }. Never remove the outline without a replacement.",
  "skip-link-missing": 'Make the first link <a class="skip" href="#main">Skip to content</a>, shown when it has focus, and give the main content id="main".',
  "tablet-overflow": "Find the element wider than 768 px and give it max-width: 100%; when it sits in a flex or grid row, also min-width: 0.",
  "deprecated-api": "Open DevTools > Issues on this page and replace each deprecated API it lists (for example an unload handler with pagehide).",
  "quirks-mode": "Start the HTML with <!doctype html>.",
  "page-weight": "Resize and compress images, split JavaScript by route, and load below-the-fold media lazily (loading=\"lazy\").",
  "image-format": "Serve WebP or AVIF: a <picture> element with a JPEG fallback, or an image CDN that picks the format from the Accept header.",
  "font-display": "Add font-display: swap (or optional) to each @font-face; for Google Fonts add &display=swap to the URL.",
  "https-missing": "Serve the site over HTTPS (a free certificate from Let's Encrypt or your host) and redirect http:// to https://.",
  "http-no-redirect": "Answer every http:// request with a 301 redirect to the same https:// address.",
  "hsts-missing": "Send Strict-Transport-Security: max-age=31536000; includeSubDomains on every HTTPS response.",
  "csp-missing": "Send a Content-Security-Policy with script-src (or default-src), for example default-src 'self'; script-src 'self' plus the hosts or nonces your scripts need. Try it as Content-Security-Policy-Report-Only first.",
  "nosniff-missing": "Send X-Content-Type-Options: nosniff on every response.",
  "clickjack-unprotected": "Send Content-Security-Policy: frame-ancestors 'self' (or X-Frame-Options: SAMEORIGIN).",
  "cookie-insecure": "Set-Cookie: name=value; Secure; HttpOnly; SameSite=Lax (leave HttpOnly off only for cookies your scripts must read).",
  "meta-description-missing": '<meta name="description" content="One or two sentences on what this page offers.">',
  noindex: "Remove noindex from the robots meta tag or the X-Robots-Tag header if this page should be found in search.",
  "social-preview-missing": '<meta property="og:title" content="Page title"> and <meta property="og:image" content="https://example.com/preview.png"> (1200 by 630 px).',
  "favicon-missing": '<link rel="icon" href="/favicon.svg"> (an SVG, PNG or ICO), or serve /favicon.ico.',
  "link-text-generic": 'Say where each link goes ("See pricing", "Read the 2025 report"), or add the subject in visually hidden text.',
};

/** Fixes for the axe-core rules that come up most; every other rule points at its own guide (detail.helpUrl). */
const AXE_FIX: Record<string, string> = {
  "color-contrast": "Darken the text or lighten its background until the ratio reaches 4.5:1 (3:1 for text at least 24 px, or 18.66 px bold).",
  "image-alt": 'Give each image an alt attribute: a short description of what it shows, or alt="" when it is decoration.',
  "link-name": "Give each link text a screen reader can read: visible words, or aria-label on a link that is only an icon.",
  "button-name": "Give each button a name: visible text, or aria-label on a button that is only an icon.",
  label: "Connect a <label for> to each form field, or give the field aria-label.",
  "select-name": "Connect a <label for> to each select, or give it aria-label.",
  "html-has-lang": 'Add lang to <html>, for example <html lang="en">.',
  "html-lang-valid": "Use a valid language code in <html lang>, for example en or fr-CA.",
  "document-title": "Give the page a <title> that says what it is.",
  region: "Put the page's content inside landmarks: <header>, <nav>, <main> and <footer>.",
  "landmark-one-main": "Wrap the main content in one <main> element.",
  "page-has-heading-one": "Give the page one <h1> that names it.",
  "heading-order": "Do not skip heading levels: an <h2> follows the <h1>, an <h3> follows an <h2>.",
  list: "Put only <li> elements (or script and template) directly inside <ul> and <ol>.",
  listitem: "Use <li> only directly inside <ul>, <ol> or <menu>.",
  "aria-hidden-focus": 'Take focusable elements out of aria-hidden parts of the page, or give them tabindex="-1".',
  "frame-title": "Give each iframe a title that says what it contains.",
  "scrollable-region-focusable": 'Make the scrolling region reachable by keyboard: tabindex="0" on it, or a focusable element inside it.',
  "nested-interactive": "Do not put a link or button inside another link or button.",
  "link-in-text-block": "Underline links inside text, or give them 3:1 contrast with the text around them.",
  "empty-heading": "Give each heading text, or remove the empty heading.",
  "landmark-unique": "Give landmarks of the same type different labels (aria-label).",
  "svg-img-alt": "Give the SVG a name: aria-label, or a <title> as its first child.",
  "role-img-alt": "Give the element with role=img a name: aria-label or aria-labelledby.",
  "aria-allowed-attr": "Remove ARIA attributes the element's role does not allow.",
  "aria-valid-attr-value": "Give each ARIA attribute a value it allows (an id that exists, true or false, a listed token).",
  "aria-required-children": "Give the role the child roles it requires, for example option inside listbox.",
  "aria-required-parent": "Put the element inside the parent role it requires, for example tab inside tablist.",
  "duplicate-id-aria": "Give every element that ARIA refers to a unique id.",
  "meta-refresh": "Remove <meta http-equiv=refresh> with a delay, or let people turn it off.",
  "landmark-banner-is-top-level": "Do not nest the banner landmark (<header>) inside another landmark.",
  "landmark-contentinfo-is-top-level": "Do not nest the contentinfo landmark (<footer>) inside another landmark.",
  "landmark-no-duplicate-banner": "Keep one top-level <header> (banner) per page.",
  "landmark-no-duplicate-contentinfo": "Keep one top-level <footer> (contentinfo) per page.",
  "input-image-alt": "Give each <input type=image> an alt attribute that names its action.",
  "avoid-inline-spacing": "Do not set line-height, letter-spacing or word-spacing with !important in style attributes, so readers can change them.",
};

const sentence = (t: string): string => {
  const x = t.trim();
  return x ? `${x.charAt(0).toUpperCase()}${x.slice(1)}${/[.!?]$/.test(x) ? "" : "."}` : "";
};

/** The suggested fix for a finding: the check's own CSS and fix text when it gave them, else a fix for the kind or rule. */
export function suggestFix(f: RawFinding): string {
  const d = f.detail ?? {};
  if (f.kind === "duplicate-submit")
    return "Disable the button while the request is in flight: form.addEventListener(\"submit\", (e) => { e.submitter && (e.submitter.disabled = true); }); and send an idempotency key so the server can drop a repeat.";
  if (f.kind === "genclass-detection") return (DIAGNOSIS_WORDS[diagnosisKey(f)] ?? DIAGNOSIS_WORDS.stale).fix;
  if (f.kind === "visual-judged") return JUDGE_FIX[judgedVerdict(f)];
  if (f.kind === "axe") {
    const rule = String(d.rule ?? "");
    return Object.hasOwn(AXE_FIX, rule) ? AXE_FIX[rule] : "Follow the rule's guide, linked above: it shows passing and failing examples for this rule.";
  }
  const css = typeof d.css === "string" ? d.css.trim() : "";
  const note = typeof d.cssNote === "string" ? d.cssNote.trim() : "";
  const text = typeof d.fixText === "string" ? sentence(d.fixText) : "";
  const parts = [css, note ? sentence(note) : "", text].filter(Boolean);
  return parts.length ? parts.join("\n") : GENERIC_FIX[f.kind];
}

/** The problem a model-judged finding names (one of the judge's verdict options), or "" when none of them. */
function judgedVerdict(f: RawFinding): string {
  const v = String(f.detail?.verdict ?? "");
  return Object.hasOwn(JUDGE_WHAT, v) ? v : "";
}

/** The words to use for a GenClass detection: its diagnosis, with a duplicate GET kept apart from a duplicate write. */
function diagnosisKey(f: RawFinding): string {
  const d = String(f.detail?.diagnosis);
  return d === "duplicate" && safeSubject(f) ? "duplicate-read" : d;
}

/** The headline and the reason for a finding (a GenClass detection uses its diagnosis; an axe-core rule its own help). */
export function describe(f: RawFinding): { what: string; why: string } {
  if (f.kind === "genclass-detection") {
    const w = Object.hasOwn(DIAGNOSIS_WORDS, diagnosisKey(f)) ? DIAGNOSIS_WORDS[diagnosisKey(f)] : null;
    if (w) return { what: w.what, why: w.why };
  }
  if (f.kind === "visual-judged") {
    const v = judgedVerdict(f);
    return { what: v ? JUDGE_WHAT[v] : KINDS["visual-judged"].what, why: JUDGE_WHY };
  }
  if (f.kind === "axe") {
    const help = typeof f.detail?.help === "string" ? f.detail.help.trim() : "";
    const description = typeof f.detail?.description === "string" ? f.detail.description.trim() : "";
    return { what: help ? sentence(help).replace(/\.$/, "") : KINDS.axe.what, why: description ? sentence(description) : KINDS.axe.why };
  }
  return { what: KINDS[f.kind].what, why: KINDS[f.kind].why };
}

// ------------------------------------------------------------------------------------- data from the page

const clamp = (v: unknown, n: number): string => {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  // control characters (other than tab and newline) never reach the report
  const clean = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, " ");
  return clean.length > n ? clean.slice(0, n) : clean;
};
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Detail fields that hold a check's suggested CSS or fix in words, or a rule's description: kept up to 600 characters, the rest 200. */
const LONG_DETAIL = new Set(["css", "cssNote", "fixText", "fixCss", "description"]);
/** An axe-core rule id. */
export const AXE_RULE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A finding as returned by code running in the scanned page, made safe to store and show on genclass.dev: a kind the
 * catalog knows (own properties only; an axe-core finding also needs a well-formed rule id), strings cut to size with
 * control characters removed, a numeric box, and a detail object of short primitives and small arrays. Null when it is
 * not a finding.
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
      else if (typeof val === "string") detail[k] = clamp(val, LONG_DETAIL.has(k) ? 600 : 200);
      else if (Array.isArray(val)) {
        detail[k] = val.slice(0, 8).filter((x) => (typeof x === "number" ? Number.isFinite(x) : typeof x === "string")).map((x) => (typeof x === "string" ? clamp(x, 200) : x));
      }
    }
  }
  if (o.kind === "axe" && (typeof detail.rule !== "string" || !AXE_RULE.test(detail.rule))) return null;
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
