// The recorded GenClass demo's estimate (owner request, 2026-10-26/27). The Snow Day Predictor's project received
// almost none of the site's traffic (the live site sent its events to another project's key) and the dashboard has no
// place for the runtime's measured checks (scroll locks, click blocks, invisible text, ads over content), so for that
// project the dashboard page draws this estimate instead of the measured counts: the week since GenClass was installed,
// 2,582 visitors (Search Console), and the 1,037 problems and 458 live fixes the owner counted on the site. Only the
// dashboard page uses it (DASH_JS demoStats); the stats API, exports, the MCP server and stored data keep the measured
// counts. Remove the entry after the recording.
// No imports.

/** One kind of problem the dashboard does not know by name. */
export interface DemoType {
  name: string;
  c: string;
  what: string;
  fix: string;
  step: string;
}

/** The estimate a project's dashboard page shows (see DASH_JS demoStats for how it is spread over the period). */
export interface DemoData {
  visitors: number;
  /** Share of the week's traffic per day, oldest first; the last one is today. */
  days: number[];
  /** Share of a day's traffic per UTC hour (the 24 h view), and the share of the week the last 24 hours had. */
  hours: number[];
  lastDay: number;
  /** Page loads (and page views) per page. */
  pages: Record<string, number>;
  /** Problems per kind and page. */
  problems: Record<string, Record<string, number>>;
  /** Problems fixed on users' screens, per action, and how many of those users undid. */
  fixed: Record<string, number>;
  undone: number;
  possible: Record<string, Record<string, number>>;
  modelFailed: number;
  types: Record<string, DemoType>;
  actions: Record<string, string>;
  slots: string[];
  /** Interaction analytics: visits, one-page visits, entry and exit pages, sources, devices, clicks. */
  bounces: number;
  entry: Record<string, number>;
  exit: Record<string, number>;
  ref: Record<string, number>;
  device: Record<string, number>;
  browser: Record<string, number>;
  os: Record<string, number>;
  country: Record<string, number>;
  returning: Record<string, number>;
  engagedSec: number;
  clicks: Record<string, number>;
  rage: Record<string, number>;
  dead: Record<string, number>;
  /** The latest rows of the Activity view, newest first: kind, page, action when GenClass acted. */
  recent: [string, string, string | null][];
}

// visits by local hour in Ontario (school mornings and the evening before), shifted to UTC (EDT, UTC-4)
const LOCAL = [3, 2, 1, 1, 1, 2, 6, 9, 7, 4, 3, 3, 4, 3, 3, 4, 5, 6, 7, 8, 9, 10, 8, 5];

const SNOWDAY: DemoData = {
  visitors: 2582,
  days: [0.07, 0.1, 0.12, 0.15, 0.22, 0.2, 0.14],
  hours: LOCAL.map((_, h) => LOCAL[(h + 20) % 24]!),
  lastDay: 0.17,
  pages: {
    "/": 2214,
    "/methodology": 402,
    "/articles/historical-trends": 287,
    "/about": 151,
    "/articles/snow-day-activities": 133,
    "/articles/hdsb-decision-process": 79,
    "/sources": 48,
    "/editorial-policy": 25,
    "/privacy": 22,
  },
  problems: {
    stale: { "/": 318 },
    scroll_lock: { "/": 151, "/methodology": 27, "/articles/historical-trends": 18 },
    duplicate: { "/": 164 },
    click_block: { "/": 112 },
    ads_cover: { "/": 38, "/articles/historical-trends": 21, "/articles/snow-day-activities": 18 },
    failing: { "/": 52, "/methodology": 19 },
    slow: { "/": 41, "/articles/historical-trends": 17 },
    invisible_text: { "/": 41 },
  },
  fixed: { discard: 241, unlock_scroll: 131, unblock_clicks: 52, fix_contrast: 34 },
  undone: 3,
  possible: { stale: { "/": 37 }, conflict: { "/": 24 }, slow: { "/": 22, "/methodology": 19 } },
  modelFailed: 9,
  types: {
    scroll_lock: {
      name: "Scroll locked",
      c: "--t3",
      what: "The page stopped scrolling: the notice left overflow: hidden on the page after it closed, so everything below the fold, the ads included, was out of reach.",
      fix: "Remove the lock in the same code path that closes the notice, error and cancel paths included. In guard mode GenClass removes the leaked lock on the user's screen.",
      step: "genclass_findings lists it as a measured check (scroll-lock-stuck) on {page}: genclass_explain on it, then fix the code path that leaves overflow: hidden behind.",
    },
    click_block: {
      name: "Page stopped taking clicks",
      c: "--t4",
      what: "Nothing on the page responded to clicks: Predict set pointer-events: none on the body and only cleared it when the request succeeded, so a mistyped postal code froze the page.",
      fix: "Clear the click block in a finally block, so the error path unblocks too. In guard mode GenClass removes the leaked pointer-events: none on the user's screen.",
      step: "genclass_findings lists it as a measured check (pointer-events-leak) on {page}: genclass_explain on it, then make every path through Predict clear the block.",
    },
    ads_cover: {
      name: "Ads covering content",
      c: "--t5",
      what: "An ad sat on top of the page's content and covered more than half of the screen.",
      fix: "Reserve each ad's space in the layout and keep in-content ads out of fixed overlays. GenClass reports these and leaves the ads alone.",
      step: "genclass_findings lists it as a measured check (ad-heavy, interstitial) on {page}: genclass_explain on it, then give the ad slot its own space in the layout.",
    },
    invisible_text: {
      name: "Invisible text",
      c: "--t0",
      what: "Text drawn in its background's colour, contrast 1.00:1: the storm-watch banner was white on white.",
      fix: "Set the text colour and the background together on the same selector, with the dark-mode variant. In guard mode GenClass applies a readable colour on the user's screen.",
      step: "genclass_findings lists it as a measured check (text-invisible) on {page}: genclass_explain on it, then fix the banner's colours in the stylesheet.",
    },
  },
  actions: {
    unlock_scroll: "Restored scrolling (removed a leaked overflow: hidden)",
    unblock_clicks: "Restored clicks (removed a leaked pointer-events: none)",
    fix_contrast: "Made invisible text readable (one CSS rule)",
  },
  slots: ["stale", "duplicate", "scroll_lock", "click_block", "ads_cover"],
  bounces: 1859,
  entry: { "/": 2031, "/articles/historical-trends": 214, "/methodology": 167, "/articles/snow-day-activities": 98, "/about": 41, "/articles/hdsb-decision-process": 31 },
  exit: { "/": 1804, "/methodology": 297, "/articles/historical-trends": 231, "/about": 104, "/articles/snow-day-activities": 92, "/sources": 54 },
  ref: { "google.com": 1694, "(direct)": 547, "bing.com": 118, "reddit.com": 96, "facebook.com": 61, "duckduckgo.com": 39, "instagram.com": 27 },
  device: { mobile: 1693, desktop: 812, tablet: 77 },
  browser: { Chrome: 1281, Safari: 1019, Edge: 148, Firefox: 79, "Samsung Internet": 55 },
  os: { iOS: 1064, Android: 641, Windows: 571, macOS: 248, ChromeOS: 58 },
  country: { CA: 2318, US: 241, GB: 11, IN: 7, FR: 5 },
  returning: { new: 1724, returning: 858 },
  engagedSec: 41,
  clicks: { "/\tbutton Predict": 2207, "/\tinput Postal code": 1388, "/\tbutton Snow day": 529, "/\tbutton OK": 412, "/\tbutton No snow day": 211, "/methodology\ta Back to the predictor": 165 },
  rage: { "/\tbutton Predict": 104, "/\tinput Postal code": 49, "/\tbutton Snow day": 34 },
  dead: { "/\tbutton Predict": 118, "/\ta Methodology": 67, "/\tinput School board": 56 },
  recent: [
    ["stale", "/", "discard"],
    ["scroll_lock", "/", "unlock_scroll"],
    ["duplicate", "/", null],
    ["stale", "/", "discard"],
    ["click_block", "/", "unblock_clicks"],
    ["ads_cover", "/articles/historical-trends", null],
    ["scroll_lock", "/methodology", "unlock_scroll"],
    ["stale", "/", "discard"],
    ["failing", "/", null],
    ["invisible_text", "/", "fix_contrast"],
    ["duplicate", "/", null],
    ["stale", "/", null],
    ["slow", "/articles/historical-trends", null],
    ["scroll_lock", "/", "unlock_scroll"],
    ["click_block", "/", null],
    ["stale", "/", "discard"],
    ["ads_cover", "/", null],
    ["duplicate", "/", null],
    ["scroll_lock", "/articles/historical-trends", "unlock_scroll"],
    ["stale", "/", "discard"],
  ],
};

const DEMOS: { name: RegExp; data: DemoData }[] = [{ name: /snow\s*-?day/i, data: SNOWDAY }];

/** The demo estimate for a project, matched by its name, or null for every other project. */
export function demoData(name: string): DemoData | null {
  for (const d of DEMOS) if (d.name.test(name)) return d.data;
  return null;
}
