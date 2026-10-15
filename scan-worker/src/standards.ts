// The standards findings cite: WCAG 2.2 success criteria (with the W3C's Understanding page), the web.dev Core Web
// Vitals thresholds, the Lighthouse audits whose thresholds the page audits use, the specs behind the reliability
// checks, and the RFCs, W3C specs and OWASP cheat sheets behind the security checks. Every link here is to the standard itself, never to a page of ours.

export interface Standard {
  /** "WCAG 2.2 SC 1.4.3 Contrast (Minimum), level AA" */
  label: string;
  url: string;
}

/** WCAG 2.2 success criteria at levels A and AA (4.1.1 Parsing is obsolete in 2.2 and left out). */
const WCAG: Record<string, [title: string, level: "A" | "AA", slug: string]> = {
  "1.1.1": ["Non-text Content", "A", "non-text-content"],
  "1.2.1": ["Audio-only and Video-only (Prerecorded)", "A", "audio-only-and-video-only-prerecorded"],
  "1.2.2": ["Captions (Prerecorded)", "A", "captions-prerecorded"],
  "1.2.3": ["Audio Description or Media Alternative (Prerecorded)", "A", "audio-description-or-media-alternative-prerecorded"],
  "1.2.4": ["Captions (Live)", "AA", "captions-live"],
  "1.2.5": ["Audio Description (Prerecorded)", "AA", "audio-description-prerecorded"],
  "1.3.1": ["Info and Relationships", "A", "info-and-relationships"],
  "1.3.2": ["Meaningful Sequence", "A", "meaningful-sequence"],
  "1.3.3": ["Sensory Characteristics", "A", "sensory-characteristics"],
  "1.3.4": ["Orientation", "AA", "orientation"],
  "1.3.5": ["Identify Input Purpose", "AA", "identify-input-purpose"],
  "1.4.1": ["Use of Color", "A", "use-of-color"],
  "1.4.2": ["Audio Control", "A", "audio-control"],
  "1.4.3": ["Contrast (Minimum)", "AA", "contrast-minimum"],
  "1.4.4": ["Resize Text", "AA", "resize-text"],
  "1.4.5": ["Images of Text", "AA", "images-of-text"],
  "1.4.10": ["Reflow", "AA", "reflow"],
  "1.4.11": ["Non-text Contrast", "AA", "non-text-contrast"],
  "1.4.12": ["Text Spacing", "AA", "text-spacing"],
  "1.4.13": ["Content on Hover or Focus", "AA", "content-on-hover-or-focus"],
  "2.1.1": ["Keyboard", "A", "keyboard"],
  "2.1.2": ["No Keyboard Trap", "A", "no-keyboard-trap"],
  "2.1.4": ["Character Key Shortcuts", "A", "character-key-shortcuts"],
  "2.2.1": ["Timing Adjustable", "A", "timing-adjustable"],
  "2.2.2": ["Pause, Stop, Hide", "A", "pause-stop-hide"],
  "2.3.1": ["Three Flashes or Below Threshold", "A", "three-flashes-or-below-threshold"],
  "2.4.1": ["Bypass Blocks", "A", "bypass-blocks"],
  "2.4.2": ["Page Titled", "A", "page-titled"],
  "2.4.3": ["Focus Order", "A", "focus-order"],
  "2.4.4": ["Link Purpose (In Context)", "A", "link-purpose-in-context"],
  "2.4.5": ["Multiple Ways", "AA", "multiple-ways"],
  "2.4.6": ["Headings and Labels", "AA", "headings-and-labels"],
  "2.4.7": ["Focus Visible", "AA", "focus-visible"],
  "2.4.11": ["Focus Not Obscured (Minimum)", "AA", "focus-not-obscured-minimum"],
  "2.5.1": ["Pointer Gestures", "A", "pointer-gestures"],
  "2.5.2": ["Pointer Cancellation", "A", "pointer-cancellation"],
  "2.5.3": ["Label in Name", "A", "label-in-name"],
  "2.5.4": ["Motion Actuation", "A", "motion-actuation"],
  "2.5.7": ["Dragging Movements", "AA", "dragging-movements"],
  "2.5.8": ["Target Size (Minimum)", "AA", "target-size-minimum"],
  "3.1.1": ["Language of Page", "A", "language-of-page"],
  "3.1.2": ["Language of Parts", "AA", "language-of-parts"],
  "3.2.1": ["On Focus", "A", "on-focus"],
  "3.2.2": ["On Input", "A", "on-input"],
  "3.2.3": ["Consistent Navigation", "AA", "consistent-navigation"],
  "3.2.4": ["Consistent Identification", "AA", "consistent-identification"],
  "3.2.6": ["Consistent Help", "A", "consistent-help"],
  "3.3.1": ["Error Identification", "A", "error-identification"],
  "3.3.2": ["Labels or Instructions", "A", "labels-or-instructions"],
  "3.3.3": ["Error Suggestion", "AA", "error-suggestion"],
  "3.3.4": ["Error Prevention (Legal, Financial, Data)", "AA", "error-prevention-legal-financial-data"],
  "3.3.7": ["Redundant Entry", "A", "redundant-entry"],
  "3.3.8": ["Accessible Authentication (Minimum)", "AA", "accessible-authentication-minimum"],
  "4.1.2": ["Name, Role, Value", "A", "name-role-value"],
  "4.1.3": ["Status Messages", "AA", "status-messages"],
};

/** A WCAG 2.2 success criterion as a standard: "WCAG 2.2 SC 1.4.3 Contrast (Minimum), level AA" and its Understanding page. */
export function wcag(sc: string): Standard {
  const w = Object.hasOwn(WCAG, sc) ? WCAG[sc] : null;
  if (!w) return { label: `WCAG 2.2 SC ${sc}`, url: "https://www.w3.org/TR/WCAG22/" };
  return { label: `WCAG 2.2 SC ${sc} ${w[0]}, level ${w[1]}`, url: `https://www.w3.org/WAI/WCAG22/Understanding/${w[2]}.html` };
}

/** The success criteria named by axe-core tags such as "wcag143" (1.4.3) or "wcag1412" (1.4.12), in tag order. */
export function scFromTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(t);
    if (!m) continue;
    const sc = `${m[1]}.${m[2]}.${Number(m[3])}`;
    if (!out.includes(sc)) out.push(sc);
  }
  return out;
}

/** Whether an axe-core rule is part of WCAG (A or AA at any 2.x version), rather than only a best practice. */
export const isWcagRule = (tags: readonly string[]): boolean => tags.some((t) => /^wcag2(?:1|2)?a{1,2}$/.test(t));

export const STANDARDS = {
  lcp: { label: "web.dev Largest Contentful Paint: good at most 2.5 s, poor above 4 s", url: "https://web.dev/articles/lcp" },
  cls: { label: "web.dev Cumulative Layout Shift: good at most 0.1, poor above 0.25", url: "https://web.dev/articles/cls" },
  unsized: { label: "web.dev Optimize CLS: images without dimensions", url: "https://web.dev/articles/optimize-cls#images-without-dimensions" },
  oversized: { label: "Lighthouse: Properly size images", url: "https://developer.chrome.com/docs/lighthouse/performance/uses-responsive-images" },
  jsBytes: { label: "web.dev: Reduce JavaScript payloads with code splitting", url: "https://web.dev/articles/reduce-javascript-payloads-with-code-splitting" },
  fontSize: { label: "Lighthouse: Document uses legible font sizes (12 px; at least 60% of the text)", url: "https://developer.chrome.com/docs/lighthouse/seo/font-size" },
  viewport: { label: "Lighthouse: Has a <meta name=\"viewport\"> tag with width or initial-scale", url: "https://developer.chrome.com/docs/lighthouse/pwa/viewport" },
  consoleErrors: { label: "Lighthouse: No browser errors logged to the console", url: "https://developer.chrome.com/docs/lighthouse/best-practices/errors-in-console" },
  httpStatus: { label: "RFC 9110 HTTP Semantics: 4xx client errors and 5xx server errors", url: "https://www.rfc-editor.org/rfc/rfc9110#section-15.5" },
  mixedContent: { label: "W3C Mixed Content", url: "https://www.w3.org/TR/mixed-content/" },
  axeBestPractice: { label: "axe-core best practice (not a WCAG requirement)", url: "https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md#best-practices-rules" },
  skipLink: { label: "WCAG technique G1: a link at the top of each page that goes to the main content (best practice)", url: "https://www.w3.org/WAI/WCAG22/Techniques/general/G1" },
  deprecations: { label: "Lighthouse: Avoids deprecated APIs", url: "https://developer.chrome.com/docs/lighthouse/best-practices/deprecations" },
  doctype: { label: "Lighthouse: Page has the HTML doctype", url: "https://developer.chrome.com/docs/lighthouse/best-practices/doctype" },
  byteWeight: { label: "Lighthouse: Avoid enormous network payloads (scores 90 at 2,667 KiB, 50 at 4,000 KiB)", url: "https://developer.chrome.com/docs/lighthouse/performance/total-byte-weight" },
  imageFormats: { label: "Lighthouse: Serve images in modern formats", url: "https://developer.chrome.com/docs/lighthouse/performance/uses-webp-images" },
  fontDisplay: { label: "Lighthouse: Ensure text remains visible during webfont load", url: "https://developer.chrome.com/docs/lighthouse/performance/font-display" },
  https: { label: "Lighthouse: Uses HTTPS", url: "https://developer.chrome.com/docs/lighthouse/best-practices/is-on-https" },
  tls: { label: "OWASP Transport Layer Security Cheat Sheet: redirect HTTP to HTTPS", url: "https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html" },
  hsts: { label: "RFC 6797 HTTP Strict Transport Security", url: "https://www.rfc-editor.org/rfc/rfc6797" },
  csp: { label: "W3C Content Security Policy Level 3", url: "https://www.w3.org/TR/CSP3/" },
  headers: { label: "OWASP HTTP Headers Cheat Sheet", url: "https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html" },
  clickjacking: { label: "OWASP Clickjacking Defense Cheat Sheet", url: "https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html" },
  cookies: { label: "OWASP Session Management Cheat Sheet: cookie attributes", url: "https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#cookies" },
  metaDescription: { label: "Lighthouse: Document has a meta description", url: "https://developer.chrome.com/docs/lighthouse/seo/meta-description" },
  crawlable: { label: "Lighthouse: Page isn't blocked from indexing", url: "https://developer.chrome.com/docs/lighthouse/seo/is-crawlable" },
  openGraph: { label: "The Open Graph protocol: og:title and og:image", url: "https://ogp.me/" },
  favicon: { label: "Google Search Central: Define a favicon", url: "https://developers.google.com/search/docs/appearance/favicon-in-search" },
  linkText: { label: "Lighthouse: Links have descriptive text", url: "https://developer.chrome.com/docs/lighthouse/seo/link-text" },
} as const satisfies Record<string, Standard>;

/** Hosts a standard's link may point to: anything else from stored data is dropped before it is shown. */
const STANDARD_HOSTS = /^https:\/\/(?:www\.w3\.org|web\.dev|developer\.chrome\.com|www\.rfc-editor\.org|github\.com\/dequelabs|dequeuniversity\.com|cheatsheetseries\.owasp\.org|ogp\.me|developers\.google\.com)\//;
export const safeStandardUrl = (u: unknown): string | null => (typeof u === "string" && u.length <= 300 && STANDARD_HOSTS.test(u) && !/[\s"'<>\\]/.test(u) ? u : null);
