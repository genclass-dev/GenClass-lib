# GenClass visual checks: design (v1, with v2 and v3 outlined)

Status: design written 2026-10-13; **v1 implemented** the same day on branch `wave2/visual`
(`packages/runtime/src/visual/`), with the differences listed in [section 19](#19-v1-implementation-notes). The open
owner decisions are in [section 17](#17-owner-decisions-and-open-questions). [CONTRACT.md](CONTRACT.md) section 14,
[API.md](API.md), [OPTIONS-SPEC.md](OPTIONS-SPEC.md) section 4.19 and the CHANGELOG have the matching entries.

The owner asked on 2026-10-13 for GenClass to find visual and CSS bugs that never throw an error (white text on a
white background, broken images, "so much more") and to fix them. Many generated ("vibecoded") sites and company
sites ship these bugs, and nothing in the browser reports them.

The model cannot see pixels or CSS today. It reads text situations about network and state behaviour. So v1 does not
use the model at all. v1 is a set of **measured checks**: deterministic measurements with documented thresholds, such
as a contrast ratio, an image's natural size against its rendered size, or a page's scroll width against its client
width. They also use facts the browser itself reports (an image `error` event, `FontFace.status`, a
`securitypolicyviolation` event). Every report says what was measured, on which element, against which threshold, and
suggests a CSS change for the developer. A few narrow, reversible runtime fixes exist, and they run only when the app
opts in and the mode is not `observe`.

Contents

1. [What a visual check is, and the rule 2 exception](#1-what-a-visual-check-is-and-the-rule-2-exception)
2. [Shared machinery](#2-shared-machinery)
3. [v1 checks](#3-v1-checks)
4. [Held back from v1 until measured](#4-held-back-from-v1-until-measured)
5. [v2: learned per-app visual expectations](#5-v2-learned-per-app-visual-expectations)
6. [v3: a visual situation type for the model](#6-v3-a-visual-situation-type-for-the-model)
7. [Options and defaults](#7-options-and-defaults)
8. [Scheduling and budgets](#8-scheduling-and-budgets)
9. [Reports, events, summary, sinks and audit](#9-reports-events-summary-sinks-and-audit)
10. [Telemetry](#10-telemetry)
11. [Runtime fixes and undo](#11-runtime-fixes-and-undo)
12. [CSP](#12-csp)
13. [Module layout and first-load size](#13-module-layout-and-first-load-size)
14. [Test plan](#14-test-plan)
15. [Measurement plan in CI](#15-measurement-plan-in-ci)
16. [Product wording](#16-product-wording)
17. [Owner decisions and open questions](#17-owner-decisions-and-open-questions)
18. [Sources](#18-sources)
19. [v1 implementation notes](#19-v1-implementation-notes)

## 1. What a visual check is, and the rule 2 exception

AGENTS.md rule 2 says the runtime never maps a fact pattern to a diagnosis or an action with an if/then. A visual
check is exactly such a mapping ("contrast below 1.5:1 means unreadable text"). The owner's request makes this
necessary, so rule 2 gets a documented exception, worded in AGENTS.md as:

> Exception (owner, 2026-10-13): visual checks in `src/visual/` are measured checks, labelled as such
> (deterministic measurements with documented thresholds, reported as kind `"check"`, never as a model finding); they
> never decide network actions and never feed situations, facts, the event log, the gate or the model. Their runtime
> fixes follow rule 1: opt-in, reversible, never in `observe`.

What follows from that:

- **Labelled as measured.** Reports have kind `"check"` and `source: "check"`. The console line starts
  `[GenClass] Check (measured):` and never shows a probability in parentheses, so it cannot be read as model output.
  Checks never fire the `detect` event (a `Detection` is a model `Decision`, and telemetry and devtools count it as a
  model finding).
- **Separate from the network-boundary model.** `src/visual/` imports nothing from `situation/`, `decide/`,
  `model/`, `state/`, `trace/` or `runtime.ts` (types excepted). `situation/`, `decide/`, `model/`, `state/` and
  `trace/` never import `src/visual/`; `runtime.ts` imports only the stub `src/visual/start.ts` and hands it a narrow
  host (section 13). A purity test enforces both directions (section 14). Checks never push `RtEvent`s, so the situation timeline is byte-identical with visual on
  or off. Visual counts never feed a decision, the policy gate or the breaker.
- **Rule 1 still binds.** In `observe`, the visual layer writes nothing to the page: no attributes, no styles, no
  inserted elements, no scrolling, no focus changes. Its only side effect is downloading its own chunk (same origin as
  the runtime). Every runtime fix is opt-in, reversible, re-measured, and never runs in `observe` (section 11).
- **Rule 3 is untouched.** No change to `src/situation/*`, facts, questions, diagnoses, actions, op or event names.
  The model-visible tag stays `situation-v2.3`. A visual situation type for the model is v3 and needs a new tag
  (section 6).
- **Rule 5.** All timing uses the injected `Clock`. Idle callbacks use `requestIdleCallback` read from the runtime's
  injected `global`, as `decide/summary.ts` does (`model/host.ts` also schedules its model load through
  `requestIdleCallback`), with a `Clock` timer as the fallback. Slice budgets are measured with `clock.now()`. Session
  sampling hashes the session id; no `Math.random`.
- **Rule 7.** No new dependency. axe-core is not added; the contrast pipeline below reimplements the parts of its
  approach that matter (stack at text rects, walk to the first opaque layer, abstain on anything complex).
- **Rule 8.** No visual telemetry ships until the owner approves the exact fields (section 10).

## 2. Shared machinery

Most of the precision comes from these shared pieces, not from any single check.

### 2.1 Visibility predicate `visible(el)`

True when all hold:

- `el.isConnected`, and `el.checkVisibility({ opacityProperty: true, visibilityProperty: true,
  contentVisibilityAuto: true })` is true (Baseline since March 2024; Chrome 105 to 120 use the `checkOpacity` alias;
  without the method, a computed-style walk for `display`, `visibility` and `opacity`).
- The border box is at least 2 x 2 CSS px.
- No ancestor (crossing open shadow roots) has `aria-hidden="true"`, `inert`, `data-genclass-ignore`, or matches a
  selector in `visual.ignore`; it is not inside a closed `<details>` other than its `<summary>`.
- Not screen-reader-only: not `clip: rect(0 0 0 0)` or `clip-path: inset(50%)`; not a box of 1 x 1 px or smaller with
  overflow hidden; not entirely outside the document's scrollable area (for example `left: -9999px`); no
  `text-indent` of -999 px or less.

`inViewport(el)`: the border box intersects the layout viewport (`0..innerWidth` x `0..innerHeight`). Long-lived
viewport tracking uses one `IntersectionObserver` per candidate set.

### 2.2 Page abstain conditions

A check that depends on colours, text or layout does not run, and the pass records why, while any of these hold:

| condition | read from | checks affected |
|---|---|---|
| forced colours | `matchMedia("(forced-colors: active)")` | colour checks |
| a colour-rewriting extension | `meta[name="darkreader"]`, `html[data-darkreader-mode]`, `html[data-darkreader-scheme]` | colour checks |
| browser page translation | `html.translated-ltr`, `html.translated-rtl` | text checks, overflow |
| pinch zoom | `visualViewport.scale > 1.01` | layout checks |
| print | `matchMedia("print")` | all |
| hidden tab | `document.visibilityState !== "visible"` | all; the pass waits |
| prerendering | `document.prerendering` | all; the pass waits for `prerenderingchange` |
| no layout engine | `documentElement.getBoundingClientRect().width === 0` or `innerWidth === 0` (jsdom, happy-dom, hidden iframes) | all; zero findings and one debug log |

The hidden-tab rule matters: this repo already shipped a misleading demo result that came from a hidden or occluded
tab (`IntersectionObserver` and `requestAnimationFrame` pause there). Visual checks never measure in a hidden tab, and
every browser test asserts `visibilityState === "visible"`.

### 2.3 Settle and persistence gates

- **Page settle**: after the `load` event (capped at 5 s), a further 1,500 ms on the Clock, `document.fonts.ready`
  (capped at 3 s), network quiet (no in-flight request known to the runtime for 500 ms, capped at 10 s), and 500 ms
  without DOM mutations (capped at 10 s).
- **Persistence**: a layout or colour finding is reported only when two measurements at least 1,000 ms apart (on the
  Clock) give the same verdict, and no running `Animation` (CSS animation or transition, from
  `document.getAnimations()`, collected once per pass into a set of targets) targets the element or an ancestor.
  An element that is still animating at the second measurement is skipped for that pass.

### 2.4 Effective background resolver

Used by `text-invisible`. It follows the structure of axe-core's color-contrast rule and abstains wherever that rule
returns "incomplete".

1. Sample points: the centre of the first and last line boxes of the element's first direct text node
   (`Range.getClientRects()`), and the centre of the element's content box.
2. At each point, `document.elementsFromPoint(x, y)`. The element itself, or one of its descendants, must be on top;
   otherwise the result is `covered` (other checks handle covering).
3. Walk the stack from the element downwards and composite each layer's `background-color` (with its alpha) until a
   layer is opaque.
4. Abstain (`unknown`, counted locally, never reported) if any layer passed before the opaque one: has
   `background-image` other than `none` (images and gradients); is an `img`, `picture`, `video`, `canvas`, `svg`,
   `iframe`, `object` or `embed`; has `filter`, `backdrop-filter` or a `mix-blend-mode` other than `normal`; has a
   `::before` or `::after` with `content` other than `none` and a non-transparent background; or when any ancestor of
   the element has `opacity` strictly between 0 and 1.
5. If no opaque layer is found, use the root: `html`'s background if opaque, else `body`'s (CSS background
   propagation), else the canvas. The canvas is white unless the root's computed `color-scheme` allows dark and
   `matchMedia("(prefers-color-scheme: dark)")` matches; then the canvas is one of the UA dark canvases (Chrome
   `#121212`, Safari `#1e1e1e`, Firefox `#1c1c22`), and the verdict must hold for all three or the check abstains.
   (axe assumes white here; its issue #4608 is still open. The owner's white-on-white case is the light half of this.)
6. All three points must resolve to the same colour (each channel within 1 of 255), or the check abstains.

The page is never probed by inserting an element (observe changes nothing), so the Canvas system colour is never
read that way.

### 2.5 Colour parsing and contrast

- A parser for the computed colour forms browsers return: `rgb()`/`rgba()`, `hsl()`, `hwb()`, `lab()`, `lch()`,
  `oklab()`, `oklch()` (Tailwind v4 colours come back from `getComputedStyle` as `oklch`), `color(srgb | srgb-linear
  | display-p3 ...)` and the forms `color-mix()` serialises to. Converted to sRGB and clipped to gamut. A colour that
  does not parse means the check abstains.
- Contrast follows WCAG 2.2: linearise each sRGB channel (`c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4`),
  `L = 0.2126 R + 0.7152 G + 0.0722 B`, ratio `(L1 + 0.05) / (L2 + 0.05)`, truncated to two decimals as axe does.
- Large text (for the suggestion's target ratio): at least 24 CSS px, or at least 18.66 px with computed
  `font-weight` 700 or more.

### 2.6 Selectors and targets (local only)

Each finding carries `target` (the existing `describeElement` text, for example `p "Ship faster with..."`) and a
`selector` for the developer. The selector prefers `#id` (when the id does not look generated, such as `:r1:` or
`headlessui-menu-12`), then `[data-testid="..."]`, then the tag with up to two stable classes (hashed classes from CSS
modules, styled-components and emotion are dropped), then an `nth-of-type` path of up to 4 levels under the nearest
ancestor with an id. A structural selector comes with the note "apply the change in the component that renders this
element". Selectors, text, colours and URLs never leave the page unless the app opts in (section 10).

When same-origin stylesheets are readable, an optional explain step names the likely source rule: the last style rule
whose `selectorText` the element matches and that sets the property involved (or the custom property it reads). It is
labelled "likely source rule", because rule order only approximates the cascade.

## 3. v1 checks

Only checks expected to be high precision are in v1. "Expected" is the honest word: no precision figure below is
measured yet. Each check must pass the gates in section 15 before it is on by default anywhere.

Severity: **high** means content or controls the visitor needs cannot be read, seen or used; **medium** means visibly
wrong but usable; **low** means a defect with a small visible effect.

| # | kind | what it finds | severity | runtime fix | browsers |
|---|---|---|---|---|---|
| 1 | `image-broken` | an `img` that failed to load | high or medium | no | all |
| 2 | `image-css-broken` | a CSS `background-image` that returned 4xx/5xx | medium | no | Chromium only |
| 3 | `media-failed` | a `video` or `audio` with no playable source | high or medium | no | all |
| 4 | `stylesheet-failed` | a first-party stylesheet that failed to load | high | no | all |
| 5 | `font-failed` | a web font in use that failed to load | low | no | all |
| 6 | `icon-font-failed` | icon font failed: boxes or ligature words shown | medium or high | no | all |
| 7 | `csp-blocked` | CSP blocked a style, font, image or media | medium or high | no | all |
| 8 | `text-invisible` | text below 1.5:1 against a fully known solid background (rest, hover or focus; light or dark) | high | yes (colour) | all |
| 9 | `text-template-leak` | `[object Object]`, `Invalid Date`, `{{ x }}`, `$NaN` and similar | high | no | all |
| 10 | `text-placeholder` | Lorem ipsum, placeholder-image hosts | medium | no | all |
| 11 | `text-encoding` | mojibake, U+FFFD, double-escaped entities | medium | no | all |
| 12 | `css-var-undefined` | `var(--x)` with no fallback where `--x` is defined nowhere | low or medium | no | all |
| 13 | `image-distorted` | a stretched or squashed image | medium | no | all |
| 14 | `page-overflow-x` | the page scrolls sideways, with the culprit element | high or medium | no | all |
| 15 | `viewport-meta-missing` | a phone shows the 980 px desktop layout | high | no | all |
| 16 | `layout-shift` | a layout-shift window above 0.25 with its sources | medium | no | Chromium only |
| 17 | `page-blank` | the main region renders no text and no media | high | no | all |
| 18 | `click-blocked` | an invisible layer swallows clicks meant for a control | high | no | all |
| 19 | `pointer-events-leak` | `pointer-events: none` left on `body` or `html` | high | yes (inline only) | all |
| 20 | `scroll-lock-stuck` | the page cannot scroll after a modal closed | high | yes (inline only) | all |
| 21 | `control-unreachable` | a control covered by a fixed element even at max scroll | high | no | all |
| 22 | `focus-obscured` | a focused element or anchor target hidden under a sticky header | medium | no | all |
| 23 | `dialog-covered` | an open dialog covered by other elements, or its buttons off-screen | high | no | all |

Checks 1 to 7, 15 and 16 are mostly browser-reported and cost close to nothing (event listeners and property reads).
Checks 8 to 14 and 17 are measured layout and text checks behind the settle and persistence gates. Checks 18 to 23
run on interaction or on a cheap periodic read.

Each entry lists: what it measures, when it reports, what it skips, the evidence fields (local), the severity, the
suggested developer fix, and the runtime fix if any.

### 3.1 `image-broken`

- Measures: a capture-phase `error` listener on `document` for `img` and `source` targets; at chunk start, a scan of
  `document.images` for `complete && naturalWidth === 0` with a non-empty `currentSrc || src`. Each candidate is
  confirmed 1,000 ms later: still `complete`, still `naturalWidth === 0`, and `img.decode()` rejects.
- Reports when: confirmed, `visible`, rendered at least 16 x 16 CSS px, and either the image is same-site or its
  resource timing entry shows `responseStatus >= 400`.
- Skips: `loading="lazy"` images that are not complete; `img` with no `src`/`srcset` yet; images whose `onerror`
  swapped in a fallback that loaded (the 1 s re-check); SVGs whose `decode()` resolves; hidden and 1 x 1 images.
  Cross-origin failures with no resource timing entry (usually a content blocker or a privacy setting on the
  visitor's device) are counted, not reported.
- Evidence: `selector`, `src` (local), rendered `w x h`, `alt`, cause from the matching `PerformanceResourceTiming`
  entry: `HTTP <status>` (Chromium `responseStatus`), `status hidden (cross-origin)`, or `blocked before the request`
  (no entry: CSP, mixed content or a blocker), else `status unknown` (no `responseStatus` support).
- Severity: high when the image covers at least 10% of the viewport or is inside `main`; medium otherwise.
- Suggested fix: the URL is the fix. Paths are case-sensitive on Linux hosts; check the base path or asset prefix
  (Vite `base`, Next.js `basePath`/`assetPrefix`), drop a `public/` prefix from URLs, serve the right `Content-Type`,
  send CORS headers when the `img` has `crossorigin`. CSS only makes a failure look neutral:
  `.card img { background-color: #f3f4f6; }` with `width` and `height` attributes.
- Runtime fix: none.

### 3.2 `image-css-broken` (Chromium only)

- Measures: `PerformanceObserver({ type: "resource", buffered: true })`; entries with `initiatorType === "css"`,
  same origin, `responseStatus >= 400`. The URL is mapped to elements only when such an entry exists: a bounded scan
  (at most 1,000 elements, idle slices) of `visible` elements' computed `background-image` for `url("...")` containing
  that path.
- Reports when: at least one `visible` element uses the failed URL.
- Skips: `responseStatus` 0 (unknown, not failed); a failed URL no visible element uses (counted as unused);
  `image-set()` with another candidate that loaded. Browsers without `responseStatus` have no coverage for this kind,
  which the summary records as unsupported, not as zero.
- Evidence: `selector`, URL path (local), status, element rect, elements using it.
- Severity: medium.
- Suggested fix: fix the `url()`; a relative `url()` resolves against the stylesheet's URL, not the page's, which
  bundlers often get wrong. Add a fallback colour: `.hero { background-color: #1f2937; }`.
- Runtime fix: none.

### 3.3 `media-failed`

- Measures: capture-phase `error` on `video`, `audio` and `source`; after settle, `media.error.code` and
  `networkState` of `visible` media.
- Reports when: `error.code` is 2 (`MEDIA_ERR_NETWORK`), 3 (`MEDIA_ERR_DECODE`) or 4 (`MEDIA_ERR_SRC_NOT_SUPPORTED`),
  or `networkState === 3` (`NETWORK_NO_SOURCE`), on a `video` of at least 48 x 48 px or an `audio` with `controls`.
- Skips: `error.code` 1 (aborted); `preload="none"` media that has not started; autoplay blocked by policy (GenClass
  never calls `play()`, so it never sees that rejection); cross-origin iframe embeds (out of reach).
- Evidence: `selector`, code and its name, `currentSrc` (local), each `source` type with its `canPlayType()` result
  (for example `video/quicktime: ""`).
- Severity: high for a video covering at least 25% of the viewport; medium otherwise.
- Suggested fix: provide `<source>` in MP4 (H.264) and WebM, set a `poster`, use `muted playsinline` for autoplaying
  hero video on iOS. CSS for a neutral failure: `.hero video { background: #111; }`.
- Runtime fix: none.

### 3.4 `stylesheet-failed`

- Measures: for each `link[rel~="stylesheet"]` that is not `alternate`, not `disabled`, and whose `media` matches
  (`matchMedia(link.media || "all")`): a capture-phase `error` event (this also fires when a server returns
  `text/html` for a missing `.css` in standards mode), or `link.sheet === null` after `load`, or a resource entry with
  `responseStatus >= 400`.
- Reports when: any of those, for a same-site sheet.
- Skips: the preload-then-swap pattern before it swaps (`rel="preload" as="style"`); `media="print"`; third-party
  sheets (counted; ad blockers make them noisy). A page that only looks plain (UA `8px` body margin, serif font,
  `rgb(0, 0, 238)` links) is never reported on that alone; that observation is attached as supporting evidence.
- Evidence: `href` (local), status or cause, `media`, whether the page shows the unstyled signature.
- Severity: high.
- Suggested fix: use a root-relative `href` (`/styles.css`; a relative `styles.css` breaks on `/blog/post`), make the
  server return 404 rather than `index.html` for missing assets, check the bundler's base path.
- Runtime fix: none in v1. A single retry of the same link is a network action; if it is ever added, it goes through
  the existing policy gate, not through visual fixes.

### 3.5 `font-failed`

- Measures: `document.fonts` `loadingerror`, and after `fonts.ready`, each `FontFace` in `document.fonts` with
  `status === "error"`. Up to 200 `visible` text elements in the viewport are sampled for the first family in their
  computed `font-family`.
- Reports when: a failed face's family is the first family of at least one sampled `visible` text element.
- Skips: faces never needed (`status` stays `unloaded`); declared but unused faces; icon fonts (check 6).
- Evidence: family, weight, style, `src` URL (local), resource status where same-origin, one example `selector`, the
  number of sampled elements using it.
- Severity: low (the fallback font is still readable).
- Suggested fix: fix the `url()` relative to the stylesheet, send `Access-Control-Allow-Origin` for fonts on another
  origin (fonts are fetched in CORS mode), ship woff2, and use
  `@font-face { font-family: "Brand"; src: url("/fonts/brand.woff2") format("woff2"); font-display: swap; }` with a
  size-adjusted fallback.
- Runtime fix: none.

### 3.6 `icon-font-failed`

- Measures: among elements whose first computed family is a face with `status === "error"` (or still not loaded 3 s
  after `fonts.ready`): `getComputedStyle(el, "::before").content` containing a Private Use Area code point
  (U+E000 to U+F8FF), or, for ligature icon fonts, element text that is a single `snake_case` token
  (`/^[a-z0-9_]+$/`) rendered wider than 1.6 x its font size (a loaded ligature is about one 1 em glyph; a failed one
  prints `shopping_cart`). Class names (`fa-*`, `material-icons`, `material-symbols-*`, `bi-*`) are only a prefilter to
  find candidates; the font status decides.
- Reports when: at least one `visible` candidate in the viewport.
- Skips: fonts still loading (the 3 s wait); `font-display: block` faces within their block period; SVG icon sets.
- Evidence: family, status, the code point or the leaked word, `selector`, count, whether the icon is the only label
  of a control.
- Severity: medium; high when the icon is the only label of a button or link.
- Suggested fix: fix the font path or CORS, self-host the icon font, or switch to inline SVG; give icon-only buttons an
  `aria-label`.
- Runtime fix: none in v1.

### 3.7 `csp-blocked`

- Measures: `securitypolicyviolation` events. The first-load stub registers this listener at init (when visual is on)
  into a buffer of at most 50 events, because violations during page load cannot be queried later.
- Reports when: `disposition === "enforce"` and `effectiveDirective` is `style-src`, `style-src-elem`,
  `style-src-attr`, `font-src`, `img-src` or `media-src`.
- Skips: report-only policies; `sourceFile` or `blockedURI` with a `chrome-extension:`, `moz-extension:` or
  `safari-web-extension:` scheme (extensions injecting into the page).
- Evidence: directive, blocked origin (local), the element when the event names one, count.
- Severity: medium; high when it blocked a first-party stylesheet (check 4 then also reports).
- Suggested fix: add the origin to the matching directive, use nonces or hashes for inline styles, or move `style`
  attributes into a stylesheet (`style-src-attr`).
- Runtime fix: none.

### 3.8 `text-invisible`

The owner's first example. One check with two dimensions: the colour scheme the visitor is using, and the state
(rest, hover, focus).

- Measures: candidates are elements with a direct text node of at least one non-whitespace character, `visible`, in
  the viewport, computed `font-size` of at least 6 px, at most 200 per pass. Foreground: computed `color`, or
  `-webkit-text-fill-color` when it is not `currentcolor`. Background: the resolver in section 2.4. Ratio: section 2.5.
- Reports when: the ratio is below **1.5:1** at two measurements at least 1,000 ms apart with no running animation
  on the element or its ancestors. A fully transparent foreground counts as 1:1.
- Skips: transparent text with `background-clip: text` or `-webkit-background-clip: text` (gradient text); any
  `-webkit-text-stroke-width` above 0; any `text-shadow` other than `none`; transparent text with another `visible`
  element of the same text stacked over the same rect (layout reservers and typewriter effects); disabled controls
  and their labels (`:disabled`, `aria-disabled="true"`); form field values and placeholders (not text nodes; v1
  leaves them out); text inside `svg`; single Private Use Area glyphs (icon fonts); everything the resolver abstains
  on; everything in the page abstain list.
- States: passive capture listeners for `pointerover` and `focusin` on interactive elements (`a`, `button`,
  `summary`, `[role=button]`, `[tabindex]`). After the longest `transition-duration + transition-delay` for `color`
  and `background-color` (parsed from computed style, waited on the Clock), while `el.matches(":hover")` or
  `":focus-visible"` still holds, measure twice 250 ms apart. Report only the readable-at-rest, unreadable-in-state
  direction (hover-reveal designs go the other way on purpose). At most one state measurement per 500 ms. A touch
  "hover" is labelled `touch`.
- Scheme: the finding records `scheme: "light" | "dark"` (from `matchMedia`, plus `html` `.dark` or `data-theme` when
  present). A visitor's browser only measures its own scheme; the CI scan covers the other one (section 15).
- Evidence: `selector`, `target`, text excerpt (first 40 characters, local), foreground as computed and as sRGB hex,
  resolved background and the `selector` of the layer that supplied it, ratio, threshold, the 3 sample points,
  `state`, `scheme`, font size and weight, the likely source rule (section 2.6) when readable.
- Severity: high.
- Suggested fix: a colour on the element's selector that keeps the hue and reaches 4.5:1 (3:1 for large text)
  against the resolved background: search OKLCH lightness at the same hue and chroma, and fall back to `#000` or
  `#fff` (one of them always reaches at least 4.58:1). Example: `.hero__subtitle { color: #4b5563; }`. The advice
  line says to set colour and background together on the same selector (`.card { background: #fff; color: #111827;
  }`), or to add the dark variant (`dark:bg-zinc-900 dark:text-zinc-100`), or to delete a
  `@media (prefers-color-scheme: dark)` block the site has no design for (the create-next-app `globals.css` pattern:
  `body { color: var(--foreground) }` turns light in dark mode while components keep light backgrounds). For a state
  finding, the suggestion targets `:hover, :focus-visible` on that selector.
- Runtime fix: yes, opt-in, rest state only (section 11): one rule in GenClass's own stylesheet setting the suggested
  colour on that element, re-measured, removed if it does not clear 4.5:1 (3:1 large).

### 3.9 `text-template-leak`

- Measures: a `TreeWalker` (`SHOW_TEXT`) over text nodes inside `visible` elements, at most 5,000 nodes per pass in
  idle slices, re-walking only dirty subtrees after the first pass. Excluded containers: `code`, `pre`, `kbd`, `samp`,
  `var`, `textarea`, `input`, `select`, `script`, `style`, `template`, `noscript`, `math`, `svg`, `[contenteditable]`.
  Case-sensitive patterns, strict tier:
  - `[object Object]`
  - `Invalid Date`
  - `/\{\{\s*[\w.$\[\]]+\s*\}\}/` (Mustache, Vue, Angular, Handlebars)
  - `/\$\{\s*[\w.]+\s*\}/` (an untagged template literal)
  - `/\{%\s*\w+[^%]*%\}/` and `/<%=?\s*[\w.]+\s*%>/` (Jinja, Liquid, ERB, EJS)
  - a currency sign or unit touching `NaN`, `undefined` or `null`:
    `/[$€£¥]\s?(?:NaN|undefined|null)\b|\b(?:NaN|undefined|null)\s?(?:%|px|USD|EUR)\b/`, and `NaN:NaN`
- Reports when: the match is still present 2,000 ms later and after network quiet (uncompiled templates and hydration
  flashes are transient).
- Skips: a text node that is exactly `undefined`, `null` or `NaN` is a weak tier: counted, not reported. Translated
  pages (abstain list).
- Evidence: pattern id (for example `object-object`, `mustache`, `currency-nan`), excerpt of up to 20 characters on
  each side (local), `selector`, count on the page.
- Severity: high.
- Suggested fix: the fix is in code, not CSS: format values before rendering
  (`{price != null ? formatPrice(price) : "-"}`), never interpolate an object, check the template engine runs on that
  route. For uncompiled Vue or Angular templates, `[v-cloak] { display: none; }` or `ng-cloak`.
- Runtime fix: none (the intended value is unknown).

### 3.10 `text-placeholder`

- Measures: the same walk, for `/\blorem ipsum\b/i` and `/\bdolor sit amet\b/i`; and `img.currentSrc` hosts
  `placehold.co`, `via.placeholder.com`, `placeholder.com`, `dummyimage.com`, `picsum.photos`, `placekitten.com`.
- Reports when: persistent (2,000 ms) and `visible`. One finding per page per pattern, with a count.
- Skips: the walk exclusions; hosts and selectors in `visual.ignore` (typography and template demo sites can list
  themselves there).
- Evidence: pattern (`lorem` or the host), count, first `selector`.
- Severity: medium.
- Suggested fix: replace the copy and images; add a CI grep for `lorem ipsum` and the placeholder hosts.
- Runtime fix: none.

### 3.11 `text-encoding`

- Measures: the same walk, for mojibake byte pairs `/\u00e2\u20ac[\u2122\u0153\u201c\u201d\u02dc\u00a6\u2013\u2014]|\u00c3[\u00a9\u00a8\u00a2\u00a4\u00b6\u00bc\u00bd\u00a1]|\u00c2[\u00a9\u00ae\u00b0]/`
  (UTF-8 read as Windows-1252), the replacement character U+FFFD, and entities shown literally
  (`/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/` in rendered text, which only happens when the source was escaped twice).
- Reports when: persistent (2,000 ms).
- Skips: the walk exclusions. Correct French or Portuguese text does not produce these byte-pair sequences.
- Evidence: pattern id, excerpt (local), count, `document.characterSet`.
- Severity: medium.
- Suggested fix: `Content-Type: text/html; charset=utf-8`, `<meta charset="utf-8">` first in `head`, store text as
  utf8mb4, escape once (React already escapes).
- Runtime fix: none.

### 3.12 `css-var-undefined`

- Measures: once per stylesheet set (again when a sheet is added), in idle slices: walk `document.styleSheets` and
  `document.adoptedStyleSheets`, recursing into `@media`, `@layer`, `@supports` and `@container` (at most 5,000 rules).
  Collect every custom property defined anywhere (declarations starting with `--`, `@property` names, inline styles
  found with `[style*="--"]`) and every `var(--x)` reference without a fallback.
- Reports when: `--x` is defined nowhere, `getComputedStyle(...).getPropertyValue("--x")` is empty on both
  `documentElement` and one `visible` element matching the rule (a bounded `querySelector`), and that element exists.
- Skips: the whole check abstains if any sheet throws on `cssRules` (cross-origin without CORS) or the matched
  element is in a shadow tree; references with a fallback; names starting with `--tw-` (Tailwind internals).
- Evidence: variable name, property, rule `selector`, sheet href (local), matched element `selector`.
- Severity: medium when the property is `color`, `background-color` or `background`; low otherwise.
- Suggested fix: define the token (`:root { --primary: oklch(0.55 0.2 260); }`), check the theme CSS is imported, or
  add a fallback (`var(--primary, #2563eb)`). After a Tailwind v4 or shadcn/ui upgrade, v3-style
  `hsl(var(--primary))` can point at tokens that no longer exist; an undefined `var()` makes the declaration invalid at
  computed-value time, so the property falls back to its inherited or initial value.
- Runtime fix: none.

### 3.13 `image-distorted`

- Measures: loaded raster images (`complete`, `naturalWidth > 0`, `decode()` resolved, not SVG), computed
  `object-fit: fill` (the default), content box `w x h` from `clientWidth`/`clientHeight` minus padding (not
  `getBoundingClientRect`, which includes transforms), natural aspect `naturalWidth / naturalHeight` (density-corrected,
  follows `currentSrc`). Distortion `d = |(w / h) / (naturalWidth / naturalHeight) - 1|`.
- Reports when: `d > 0.05` and the mismatch on the smaller dimension is more than 2 px (Lighthouse
  `image-aspect-ratio` uses `THRESHOLD_PX = 2`), with `w` and `h` at least 48 px, persistent.
- Skips: `object-fit` other than `fill`; SVG; natural size 5 px or less; `image-rendering: pixelated` or
  `crisp-edges`; running animations; CSS background images (they may be sprites).
- Evidence: `selector`, natural and rendered sizes, distortion percentage, `object-fit`.
- Severity: medium.
- Suggested fix: `.product img { height: auto; }` when the width is set, or a fixed box with `object-fit: cover;`,
  and `width`/`height` attributes that match the file's ratio.
- Runtime fix: none in v1 (`object-fit` can crop or letterbox).

### 3.14 `page-overflow-x`

- Measures: page fact `documentElement.scrollWidth > documentElement.clientWidth + 1`, where the viewport's used
  `overflow-x` (from `html`, or from `body` when `html` is `visible`) is not `hidden` or `clip`. Culprit search, only
  when the fact holds: a walk in idle slices (at most 3,000 elements) for elements whose rect has
  `right > clientWidth + 1` or `left < -1`, with no clipping ancestor (`overflow-x` `hidden`, `clip`, `auto` or
  `scroll`, or `contain: paint`) between them and the root, not `position: fixed`. `visibility: hidden` elements are
  included (they still take space). Keep the outermost offenders, at most 3. Tag the cause: a width equal to `100vw`
  with a classic scrollbar (`rect.width >= innerWidth` while `clientWidth < innerWidth`), a fixed px width wider than
  the viewport, a negative margin, a translated off-canvas panel, an unbroken token of 30 or more characters, media,
  a table or an embed without `max-width`.
- Reports when: the fact holds at two measurements 1,000 ms apart and the culprit is not animating.
- Skips: pinch zoom and translation (abstain list); overflow of 1 px (scrollbar rounding); scrollers inside clipping
  containers (carousels).
- Evidence: `scrollWidth`, `clientWidth`, excess px, culprit `selector`s with their right edges, cause tag, viewport
  width.
- Severity: high when `clientWidth <= 640` or the pointer is coarse; medium otherwise.
- Suggested fix, by cause: `img, video { max-width: 100%; height: auto; }`; `width: 100%` instead of `100vw`;
  `overflow-x: clip` on the section that holds an off-canvas panel; `overflow-wrap: anywhere` for long tokens;
  `min-width: 0` on flex children; `max-width: 100%` instead of a fixed width.
- Runtime fix: none (`overflow-x: clip` on `html` can hide content that is only reachable by scrolling).

### 3.15 `viewport-meta-missing`

- Measures: on a phone (`matchMedia("(pointer: coarse)")` and `screen.width <= 500`): no `meta[name=viewport]`
  whose `content` has `width=device-width`, and `documentElement.clientWidth >= 1.5 x screen.width` (the default 980 px
  layout viewport).
- Reports when: both hold at settle.
- Skips: non-phones. Zoom-disabling content (`user-scalable=no`, `maximum-scale` below 2) is an accessibility lint,
  not a broken page; it is left to the later opt-in accessibility tier.
- Evidence: the meta `content` or "absent", `clientWidth`, `screen.width`.
- Severity: high.
- Suggested fix: `<meta name="viewport" content="width=device-width, initial-scale=1">` (HTML, not CSS).
- Runtime fix: none (inserting it reflows a page built only for 980 px and can make it worse).

### 3.16 `layout-shift` (Chromium only)

- Measures: `PerformanceObserver({ type: "layout-shift", buffered: true })`. Entries with `hadRecentInput` are
  dropped. Session windows as web.dev defines them (gap under 1 s, at most 5 s). Attribution from `entry.sources` (up
  to 5 with `node`, `previousRect`, `currentRect`). Cause tags where measurable: an `img` without `width`/`height`
  attributes and with `aspect-ratio: auto`; an element inserted within 500 ms before the shift above the shifted node
  (seen by the MutationObserver); a font swap (`loadingdone` within 100 ms).
- Reports when: a window scores above **0.25** (web.dev "poor"). Windows between 0.1 and 0.25 are counted, not
  reported.
- Skips: shifts while hidden. Safari and Firefox have no layout-shift entries: recorded as unsupported, not as zero.
- Evidence: window score, start offset from load, the top sources (`selector`, distance moved in px), cause tag.
- Severity: medium.
- Suggested fix: `width`/`height` attributes or `aspect-ratio: 16 / 9;` on the media selector; reserve space for
  inserted banners (`.promo-slot { min-height: 90px; }`); a metric-matched fallback font.
- Runtime fix: none (the shift has already happened).

### 3.17 `page-blank`

- Measures: after settle plus 3,000 ms, in `main`/`[role=main]` when one exists and is `visible`, else `body`: an
  early-exit walk that stops at the first `visible` text character or the first `visible` media item (an `img` with
  `naturalWidth > 0`, an `svg`, `canvas`, `video` or `iframe` of at least 16 x 16 px, or an element with a
  `background-image` whose resource loaded).
- Reports when: neither is found, again 2,000 ms later, with no request in flight.
- Skips: requests still in flight (waits up to 10 s more, then stays silent); canvas and WebGL apps (a canvas counts
  as content).
- Evidence: region checked, element count in the region, the runtime's error count for the session (read-only), and,
  when the region holds text that `checkVisibility` rejects, the property that hides it (for example
  `opacity: 0 on main`).
- Severity: high.
- Suggested fix: an error boundary that renders a fallback; fix the hydration or chunk-load error the runtime
  reported; when CSS hides the region, the rule on that selector (for example `main { opacity: 1; }` as the default
  state, animated from there).
- Runtime fix: none.

### 3.18 `click-blocked`

- Measures: on a user `click` (capture, passive) at `(x, y)`: the target `T` and `document.elementsFromPoint(x, y)`.
  `T` qualifies when it is not interactive (not `a`, `button`, `input`, `select`, `textarea`, `label`, `summary`, an
  interactive ARIA role, `[tabindex]` of 0 or more, `[contenteditable]`, and computed `cursor` is not `pointer`), has
  no `visible` text, is transparent (`opacity < 0.05`, or a background alpha under 0.05 with no background image, no
  visible border, no `box-shadow` and no `backdrop-filter`), covers at least 30% of the viewport, and the first
  element below it that is not its ancestor is interactive and `visible`.
- Reports when: a second click on the same `T` within 3 s qualifies again, and between the two clicks there was no DOM
  mutation (other than GenClass's own), no navigation, no request started, no focus change, and no element in the
  document has `aria-expanded="true"`.
- Skips: `T` is `html` or `body` (check 19); an active drag or pointer capture; canvas targets; any `aria-busy="true"`
  or request in flight (busy shields during a submit are intended).
- Evidence: overlay `selector`, its `z-index`, opacity, viewport coverage %, the blocked control's `selector` and
  accessible name (local), click count.
- Severity: high.
- Suggested fix: unmount the overlay after its close transition, or `.backdrop[data-state="closed"] { pointer-events:
  none; }` (generally `<overlay selector> { pointer-events: none; }`).
- Runtime fix: none in v1. Setting `pointer-events: none` on a confirmed overlay is a candidate for a later version,
  after the bench measures it.

### 3.19 `pointer-events-leak`

- Measures: one computed-style read of `pointer-events` on `html` and `body` every 2,000 ms while the tab is visible,
  and whether the value comes from an inline declaration (`el.style.getPropertyValue("pointer-events")`).
- Reports when: the value is `none` for at least 1,000 ms (two reads) while nothing open and `visible` matches
  `[role=dialog]`, `[role=alertdialog]`, `dialog[open]`, `[aria-modal=true]`, `[role=menu]`, `[role=listbox]`,
  `[data-state=open]` or `:popover-open`, and no drag is in progress. When the value comes from a stylesheet rather
  than an inline style, a user click in the last 10 s that landed on `html` or `body` is also required (a page may
  disable pointer events on `body` on purpose and re-enable them on its own elements).
- Evidence: element, source (`inline` or `stylesheet`), duration, the time since a dialog or menu was last seen
  closing, clicks that landed on `html`/`body`.
- Severity: high (the whole page ignores clicks).
- Suggested fix: with Radix or shadcn/ui, do not unmount a modal `DropdownMenu` or `Dialog` during its exit animation,
  or set `modal={false}` on a menu that opens a dialog; in general, release the lock in every close path.
- Runtime fix: yes, opt-in, only when the declaration is inline (section 11): remove that one inline declaration and
  record it for undo.

### 3.20 `scroll-lock-stuck`

- Measures: the same periodic read: computed `overflow-y` on `html` and `body`, `body` `position` and `top`, and
  whether each value is an inline declaration; `documentElement.scrollHeight` against `innerHeight`. Passive `wheel`,
  `touchmove` and `keydown` (PageDown, Space, ArrowDown, End) listeners note scroll attempts.
- Reports when: `overflow-y` is `hidden` or `clip` on `html` or `body` (or `body` is `position: fixed` with a negative
  inline `top`, the iOS scroll-lock pattern), `scrollHeight > innerHeight + 100`, nothing in the open set of check 19
  is `visible`, no `visible` fixed element covers 50% of the viewport or more (a drawer without ARIA), all for at least
  1,000 ms, and at least one scroll attempt changed neither `scrollY` nor the DOM within 300 ms.
- Skips: apps that scroll an inner container (their document `scrollHeight` equals `innerHeight`); slide sites that
  answer the wheel with transforms (a DOM attribute change counts as a response).
- Evidence: element, property and value, source (`inline` or `stylesheet`), `scrollHeight` and `innerHeight`,
  attempts without effect.
- Severity: high.
- Suggested fix: release the lock in every close path, including unmount mid-animation and route changes (cleanup in
  the effect's return); prefer lock utilities that count nested locks. A lock set through a class
  (`body.modal-open { overflow: hidden; }`) needs the class removed in the close path.
- Runtime fix: yes, opt-in, only for an inline `overflow` or `overflow-y` on `html` or `body` (section 11). The
  `position: fixed` variant is suggest-only, because undoing it needs a scroll write.

### 3.21 `control-unreachable`

- Measures: when the user reaches max scroll (`scrollY + innerHeight >= scrollHeight - 2`, from passive scroll events,
  evaluated once scrolling has been idle for 500 ms), or at settle on a page that cannot scroll: for each `visible`
  interactive element intersecting the viewport (at most 50), `elementFromPoint` at the centre and 4 inset points (25%
  in from each edge).
- Reports when: all 5 points land on one element `C` that is `position: fixed` or `sticky` (itself or an ancestor),
  is not the control, its ancestor or its descendant, is not a dialog (`[role=dialog]`, `[role=alertdialog]`,
  `[aria-modal=true]`, `dialog`), and contains no focusable element other than itself. The same result 1,000 ms
  later.
- Skips: covers that contain controls (cookie and consent banners, bottom navigation bars), which keeps this check
  precise at the cost of missing bars that hide the last row of controls (a later version, once measured); covers with
  `pointer-events: none` (hit testing passes through them).
- Evidence: control `selector` and accessible name (local), cover `selector`, its rect, `position` and `z-index`,
  points covered (5 of 5), scroll position.
- Severity: high.
- Suggested fix: reserve space for the fixed element (`body { padding-bottom: 88px; }`, the cover's height plus
  margin) or move it on small screens (`@media (max-width: 640px) { .chat-bubble { bottom: 96px; } }`).
- Runtime fix: none in v1 (a `padding-bottom` change is a later candidate).

### 3.22 `focus-obscured`

- Measures: focus: on `focusin` where the target matches `:focus-visible`, after `scrollend` (or 150 ms without a
  scroll event, on the Clock), `elementFromPoint` at the centre and 4 inset points of the focused element. Anchors: on
  `hashchange` or a click on `a[href^="#"]`, after scrolling settles, the target
  (`getElementById(decodeURIComponent(hash.slice(1)))`, or its first `visible` descendant when it has no height),
  tested at 3 points along its top edge (`rect.top + 4`, at 25%, 50% and 75% of its width).
- Reports when: every point is covered by a `fixed` or `sticky` element that does not contain the target and is not a
  dialog (WCAG 2.2 SC 2.4.11, "entirely hidden"), and the same holds 400 ms later (headers that hide on scroll get
  time to move).
- Skips: skip links; targets inside a closed drawer (`inert`, `aria-hidden`); targets that already have a
  `scroll-margin-top` at least as tall as the cover.
- Evidence: target `selector`, cover `selector`, cover height, overlap px, trigger (`focus` or `anchor`).
- Severity: medium.
- Suggested fix: `html { scroll-padding-top: calc(64px + 8px); }` (the header height plus a margin), or
  `h2[id], h3[id] { scroll-margin-top: 72px; }`; `scroll-padding-bottom` for bottom banners.
- Runtime fix: none in v1 (`scroll-padding-top` on `html` is a later candidate).

### 3.23 `dialog-covered`

- Measures: a MutationObserver (attributes and child list) notices a `[role=dialog]`, `[role=alertdialog]`,
  `[aria-modal=true]` or `dialog[open]` becoming `visible`; after its animations settle, `elementFromPoint` on a 3 x 3
  grid inset 10% inside its rect and at the centres of its focusable children (at most 20 points in all).
- Reports when: at least half the points, or the centre of any focusable child, land on an element outside the dialog
  that is not itself a dialog, at the first test and again 500 ms later. Also when a `fixed` dialog's rect extends past
  `innerHeight`, its `overflow-y` is not `auto` or `scroll`, and a focusable child lies below `innerHeight`.
- Skips: `el.matches(":modal")` (`showModal()` puts it in the top layer); `:popover-open`; a covering toast smaller
  than 10% of the dialog; nested dialogs.
- Evidence: dialog `selector`, covered share of points, cover `selector`, both `z-index` values, the first ancestor
  that creates a stacking context (`transform`, `filter`, `will-change`, `contain`), unreachable children.
- Severity: high.
- Suggested fix: render the dialog in a portal at the end of `body` or use `<dialog>` with `showModal()`; remove the
  `transform`, `filter` or `will-change` from the ancestor named in the evidence; give tall dialogs
  `max-height: 90dvh; overflow-y: auto;`.
- Runtime fix: none (moving elements or changing `z-index` is risky).

## 4. Held back from v1 until measured

These were researched and are useful, but their expected precision is medium, or they judge design rather than
breakage. Each needs bench numbers (section 15) before it ships, and some belong in an opt-in tier.

| candidate | why it waits |
|---|---|
| content stuck at `opacity: 0` (a scroll-reveal animation that never ran) | expected medium-high; cross-fade slideshows, tabs and hover reveals look the same. Report-only first |
| clipped text in a control (`scrollWidth > clientWidth + 2`, overflow hidden, no ellipsis) | expected medium-high; icons and ripples also enlarge `scrollWidth` |
| raw markdown in rendered text (`**bold**`, `[text](https://...)`) | chat UIs show typed markdown on purpose |
| lazy image that never loads | needs a reliable network-quiet signal per image |
| text over images and gradients | the runtime cannot read pixels; gradient stops are feasible, sampled images need same-origin canvas reads or a scanner |
| low contrast below WCAG AA (4.5:1, 3:1 large) | many correct-looking sites use muted greys; an opt-in accessibility tier, never "broken" |
| tiny tap targets (WCAG 2.5.8), missing focus indicator | accessibility linting, opt-in tier |
| invisible icon-only control, popover clipped by `overflow`, fixed panel taller than the viewport, utility class missing in production | expected medium to high; each needs its own false-report numbers |
| runtime fixes for `click-blocked`, `focus-obscured` (`scroll-padding-top`), `control-unreachable` (`padding-bottom`) | narrow and reversible, but each changes layout or hit testing; measure the false-fix rate first |

## 5. v2: learned per-app visual expectations

v1 checks know nothing about a particular app. Many real visual bugs only look wrong relative to how the app usually
renders: the checkout button that is always visible and clickable on `/cart` is covered by a promo layer today. v2
learns that per app, the same way `learn/profiles.ts` learns transition profiles for ops: generic counts, no
knowledge of what an element means.

- **Unit**: a route (normalised path) and an element key. The key is the stable selector from section 2.6, preferring `id`,
  `data-testid`, or role plus accessible name; elements whose only key is a structural path are not learned.
- **What is learned**, at settle on each page view, for interactive controls in the first viewport (at most 100 per
  route), headings, images of at least 48 px and the main region: present, `visible`, in the viewport,
  hit-testable at its centre (`elementFromPoint` returns it or a descendant), contrast bucket (4.5 or more, 3 to 4.5,
  1.5 to 3, below 1.5), image loaded, size bucket (log2 of width and height) and position bucket.
- **Expectation**: after at least 20 page views of the route (the same minimum as `MIN_COMPLETIONS`), a property seen
  in at least 99% of views (rare below 1%, as `RARE`) is an expectation. A view that breaks one is reported as kind
  `"check"` with `basis: "baseline"`, for example: `button "Checkout" on /cart was visible and clickable in 47 of 47
  earlier page views; now its centre is covered by div.promo-overlay`. Missing elements are not reported in v2 (A/B tests and
  personalisation remove elements on purpose).
- **Storage**: in memory per session, persisted only through the existing `learn.persist` option (localStorage or
  sessionStorage, a separate entry next to `learn.key`, at most about 30 KB). Unlike transition profiles, whose stored
  state is discarded when `learn.version` (default: the release tag) changes, visual expectations survive releases,
  because a regression after a deploy is the case worth catching. Counts are tagged with `session.tags.release`, so a
  report can say "47 views under 1.4.2, broken under 1.4.3"; an explicit `learn.version` change still resets them.
- **Limits**: one visitor's storage learns only from that visitor. Learning across visitors needs element keys sent to
  a server, which is a new data category (rule 8) and not part of v2 by default. The cross-run path that needs no
  telemetry is CI: `checkPage({ expectations })` records expectations on the main branch and compares a pull request's
  run against them (section 15).
- **Still not the model**: these are statistics over measurements, labelled `baseline`, under the same rule 2
  exception. They never feed situations or decisions.

## 6. v3: a visual situation type for the model

Plainly: this does not exist, and the current model cannot do it. v3 means teaching the model a new kind of
situation, and that is a model change under rule 3.

- **What it would be**: a new trigger (for example `render`) whose situation text describes measured facts, not
  pixels: the element's role and name, the v1 measurements and v2 baselines for it, and what happened just before
  (a failed `GET /theme.css`, a class change on `html`, a route change, a store write that toggled a modal). New
  questions ("is this a defect?", "which fix is safest?"), diagnoses (for example unreadable, covered, asset-failed,
  layout-broken, expected) and actions (report, and the visual fixes as tiered actions behind the policy gate).
- **What it needs**: a new tag (the text frozen as `situation-v2.3` cannot change), a renderer in `src/situation/`
  with its `training/curriculum/rt.py` mirror, training data (the `sim/` world has no layout engine, so rows would come
  from `realapps/` in headless Chromium with faults injected from outside and clean runs as negatives), retraining,
  calibration, and a false-intervention rate on clean runs before any action is allowed. Because measured facts
  would then feed situations, the rule 2 exception has to be rewritten too. It needs the owner's go-ahead.
- **What it would still not do**: see pixels. The model reads text. Seeing pixels needs an image model, which is a
  much larger download and CPU cost and is not planned.
- **What the model gains**: the ability to say "this is expected here" where a fixed threshold cannot (a deliberately
  low-contrast watermark, a cover the app always shows on first visit), and to connect a visual symptom to the
  network or state event that caused it.

Until v3, the model never sees visual checks and visual checks never see model output.

## 7. Options and defaults

### 7.1 Surface

```ts
interface InitOptions {
  /**
   * Measured visual checks (docs/runtime/VISUAL.md). Default: off in createRuntime(); "local" in GenClass.init()
   * in a browser (on for development hosts and when the devtools overlay is mounted, off on public hosts).
   * true turns report-only checks on everywhere. Fixes need `fix` and a guard or heal mode.
   */
  visual?: boolean | "local" | VisualOptions;
}

interface VisualOptions {
  /** Same values as the shorthand. Default "local" in GenClass.init(), false in createRuntime(). */
  on?: boolean | "local";
  /** Turn single kinds on or off. Default: every v1 kind on. */
  checks?: Partial<Record<CheckKind, boolean>>;
  /** Runtime fixes (section 11). Default false. true = the v1 fix kinds; or a list of them. */
  fix?: boolean | Array<"text-invisible" | "pointer-events-leak" | "scroll-lock-stuck">;
  /** Selectors (and hosts, for text-placeholder) never checked, for example third-party widgets. */
  ignore?: string[];
  /** Per idle slice, ms. Default 8, clamped to 2..16. */
  budgetMs?: number;
  /** Total check time per pass, ms. Default 100; the pass ends as partial. */
  passBudgetMs?: number;
  /** Candidate elements per pass. Default 2,000. */
  maxElements?: number;
  /** Low-end devices: "light" (default) runs only the near-free checks; "full" runs all; "off" runs none. */
  lowEnd?: "light" | "full" | "off";
  /** Fraction of sessions that run the full tier (default 1); session-deterministic, never Math.random. */
  sample?: number;
  /** Console lines per pass before folding (default 10). */
  maxConsoleLines?: number;
}
```

Zero-code paths use the existing merge in `cdn/config.ts`:

- `fromPairs` key `visual`: `off`/`false`/`no` gives `false`, `on`/`true` gives `true`, `local` gives `"local"`, `fix`
  gives `{ on: true, fix: true }`. So the meta tag (`<meta name="genclass" content="visual=on">`, head only),
  `data-visual` on the script tag and `window.GENCLASS_CONFIG = { visual: { ... } }` all work.
- URL: `?genclass-visual=off` always turns checks off. `?genclass-visual=on` turns on report-only checks on any host
  (the cost lands only on the person who opened the link, and nothing on the page changes). A URL can never turn on
  fixes. `?genclass=off` installs nothing, as today.
- CLI: `genclass-runtime init --no-visual` writes `visual=off` into the tag it adds.

### 7.2 Defaults and the reasoning

| entry | public host | development host (`isLocalHost`) or devtools mounted |
|---|---|---|
| `createRuntime()` | off | off |
| `GenClass.init()` / `/auto` / script tag | off | on, report-only |
| with `visual: true` | on, report-only | on, report-only |
| with `visual: { fix: true }` and `mode: "guard"` or `"heal"` | on, v1 fixes allowed | on, v1 fixes allowed |
| any, with `mode: "observe"` | never fixes | never fixes |

Why off on public hosts by default:

1. **The visitor pays the CPU.** A layout pass costs main-thread time on every page view, and on a low-end phone that
   time is 4 to 6 times larger (estimate, to be measured). The visitor gets nothing back unless a developer reads the
   reports.
2. **Nobody reads production consoles.** Until telemetry for checks is approved (section 10), production reports
   reach only an app's own `report` function or sinks. An app that wants them sets `visual: true` and wires a sink.
3. **Visitors' environments cause false reports.** Dark-mode extensions, page translation, zoom, forced colours and
   user font settings change what is measured. The abstain list covers the known ones; the bench (section 15) has to
   show the rest is rare before a production default is reconsidered.
4. **OPTIONS-SPEC rule 1.** New options narrow behaviour or export data; a new default-on cost in production is a
   behaviour change for every existing install.

Why on for development hosts: the developer is the person who benefits, the console is read, the CPU is a desktop's,
and it is the cheapest place to catch the bug. The devtools overlay also turns it on, since mounting it means someone
is looking.

CPU against coverage when on:

- **Event-driven checks run everywhere** (images, media, stylesheets, fonts, CSP, viewport meta, layout shift,
  `pointer-events` and scroll-lock reads, clicks, focus). They cost close to nothing.
- **Measured layout and text checks are time-sliced and capped** (section 8). On a low-end device they are skipped by
  default (`lowEnd: "light"`). Low-end means `navigator.deviceMemory <= 2`, or `hardwareConcurrency <= 2`, or
  `connection.saveData`, or a first slice that measured fewer than 40 text candidates in 8 ms. The summary records the
  tier, so a light session with no findings is never read as a clean result.
- **Sampling spreads the cost.** `sample: 0.1` in production runs the full tier for one session in ten, chosen by a
  hash of the session id: coverage across many visitors at a tenth of the total CPU.

Interactions with existing options: `enabled` false or pending means no checks and no chunk download; a route whose
mode is `"off"` gets no checks; `observe` (session or route) reports but never fixes; sessions sampled out by the
existing `sample` still check but never fix; `rt.disable()`, `destroy()` and `pause()` stop checks and undo fixes.

## 8. Scheduling and budgets

All timers are Clock timers; idle callbacks come from the injected global (section 1).

1. **Init (stub, first load)**: resolve the option. If off, nothing else happens: no listeners, no chunk. If on,
   register the `securitypolicyviolation` buffer (section 3.7).
2. **Load**: wait for `document.readyState === "complete"` or `load`, capped at 5 s; then 1,500 ms on the Clock; then
   an idle callback (timeout 3 s; without `requestIdleCallback`, a 0 ms Clock timer); then import the chunk.
3. **Chunk gates**: `fonts.ready` (cap 3 s), a visible tab, not prerendering, network quiet for 500 ms (the host
   exposes the in-flight count, cap 10 s), 500 ms without DOM mutations (cap 10 s).
4. **Pass 1**: cheap reads first (images, links, fonts, media, buffered layout shifts, the CSP buffer, viewport meta,
   the page overflow fact, `pointer-events` and scroll-lock state), then text and layout measurements, viewport first.
5. **Confirmation**: candidates are re-measured at least 1,000 ms later (persistence) and reported then.
6. **Incremental re-checks**: one MutationObserver on `documentElement` (child list, subtree, attributes filtered to
   `class`, `style`, `hidden`, `src`, `srcset`, `width`, `height`, `open`) collects dirty roots, dropping a root when an
   ancestor is already queued. After 1,000 ms of quiet and an idle callback, only those subtrees are re-checked. A
   class or style change on `html` or `body`, a dirty root larger than `maxElements`, or a route change schedules a full
   pass, at most one every 30 s. Image `load`/`error` queue that image. A `resize`, debounced 1,000 ms, queues the
   overflow check. `pageshow` with `persisted` queues one re-check. Mutations of `data-genclass-fix` and anything
   inside `[data-genclass-ignore]` (the devtools host) are ignored.
7. **On interaction**: `click-blocked` on clicks, `focus-obscured` on keyboard focus and anchor jumps, state
   measurements of `text-invisible` on hover and focus (at most one per 500 ms), `control-unreachable` on reaching max
   scroll, `dialog-covered` when a dialog appears.
8. **Periodic**: `pointer-events-leak` and `scroll-lock-stuck` read two computed styles every 2,000 ms while visible,
   and stop while hidden.

Budgets:

| budget | default | notes |
|---|---|---|
| slice | 8 ms (2 to 16) | a slice ends at `clock.now() - start >= budgetMs` or when `deadline.timeRemaining()` runs out; reads only, no writes, so a slice forces at most one layout |
| pass | 100 ms of check time | the pass ends as `partial` and the summary says so |
| session | 1,000 ms of check time per 10 minutes | incremental checks stop for the rest of the window; recorded as `stopped` |
| `text-invisible` | 200 elements per pass | the most expensive check (up to 3 `elementsFromPoint` calls each) |
| text walk | 5,000 text nodes per pass | template, placeholder and encoding checks share one walk |
| overflow culprit | 3,000 elements | only when the page fact holds |
| `control-unreachable` | 50 controls | 250 hit tests at most, once per max-scroll event |
| `css-var-undefined` | 5,000 rules | once per stylesheet set |
| event handlers | under 1 ms each | `click-blocked` is one `elementsFromPoint` per click |

Back-off: if one read takes more than 16 ms (a forced layout on a huge DOM), the pass ends, the settle wait doubles
and `maxElements` halves for the session. A slice never runs long enough to be a long task (50 ms), which matters
because `observe/perf.ts` records long tasks as `perf` events the model reads. If the runtime has seen a long task in
the last second (a read-only counter on the host), the next slice waits for the next idle period.

Estimated costs (to be measured by the bench and written to RESULTS.md with date and commit): 10 to 20 microseconds
per candidate with clean layout on a desktop CI runner, 0.1 to 0.4 ms per `text-invisible` element on a 4x throttled
profile; pass 1 under 50 ms on the runner for a typical page, and 100 to 200 ms of work at 4x throttling, so on a
slow phone the 100 ms pass budget can end pass 1 as partial. That is one reason low-end devices default to the light
tier.

## 9. Reports, events, summary, sinks and audit

### 9.1 Finding

```ts
type CheckKind =
  | "image-broken" | "image-css-broken" | "media-failed" | "stylesheet-failed" | "font-failed"
  | "icon-font-failed" | "csp-blocked" | "text-invisible" | "text-template-leak" | "text-placeholder"
  | "text-encoding" | "css-var-undefined" | "image-distorted" | "page-overflow-x" | "viewport-meta-missing"
  | "layout-shift" | "page-blank" | "click-blocked" | "pointer-events-leak" | "scroll-lock-stuck"
  | "control-unreachable" | "focus-obscured" | "dialog-covered";

interface CheckFinding {
  /** "c1", "c2", ... per runtime (a counter). */
  id: string;
  /** Always "check": a measurement, never a model finding. v2 baselines add basis: "baseline". */
  source: "check";
  basis?: "measurement" | "baseline";
  kind: CheckKind;
  severity: "high" | "medium" | "low";
  /** Clock time. */
  at: number;
  route?: string;
  /** describeElement text, for example 'p "Ship faster with..."'. */
  target: string;
  /** For the developer; built locally, never sent unless the app opts in. */
  selector: string;
  /** The element while it is still connected (a WeakRef), else null. */
  element(): Element | null;
  /** What was measured, for example { ratio: 1.04, fg: "#ffffff", bg: "#fafafa", fontPx: 16 }. */
  measured: Record<string, number | string | boolean>;
  threshold: { value: number | string; unit: string; source: string };
  context: { scheme: "light" | "dark"; state?: "rest" | "hover" | "focus" | "touch"; viewport: { w: number; h: number }; coarse: boolean; tier: "full" | "light" };
  /** The console line. */
  message: string;
  /** The collapsed console group: measured values, threshold source, selector, how to ignore. */
  details: string[];
  suggestion?: { selector: string; css: string; note?: string };
  fix?: { id: string; applied: boolean; css?: string; reason?: string; undo(): boolean };
  /** Elements folded into this finding (same kind and same suggested selector). */
  count?: number;
}
```

### 9.2 Console

```
[GenClass] Check (measured): text contrast 1.04:1 on p.hero__subtitle "Ship faster with...", below 1.5:1 (WCAG 2.2 contrast formula; unreadable-text threshold). Suggested CSS: .hero__subtitle { color: #4b5563; }
[GenClass] Check (measured): the page scrolls sideways on a 390 px viewport: div.pricing-table ends at 512 px (122 px too wide, fixed width). Suggested CSS: .pricing-table { max-width: 100%; }
[GenClass] Applied a CSS fix for check c3: color #4b5563 on p.hero__subtitle. Undo: GenClass.runtime.checks().find(c => c.id === "c3").fix.undo()
```

At most `maxConsoleLines` (10) lines per pass; elements with the same kind and suggested selector fold into one line
("12 elements"); then one line "and N more: GenClass.runtime.checks() or the devtools Checks tab".
`report: "interventions"` prints only applied fixes and undos; `"silent"` prints nothing; a `report` function
receives every report.

### 9.3 Report and events

- `Report.kind` gains `"check"`, and `Report.check?: CheckFinding`. The runtime's `emitReport` path is reused; the
  message text is built in the chunk.
- `RuntimeEvents.check: CheckFinding` (`rt.on("check", f => ...)`). Not `detect`.
- `rt.checks(n?)`: the last findings (a buffer of 200 on the runtime side, so the method exists, and returns an
  empty list, before the chunk loads).
- `rt.checkNow(): Promise<CheckFinding[]>`: runs a pass now (loads the chunk if needed); report-only unless the fix
  gate allows.
- Devtools: a "Checks" tab with a "measured" badge. Each card shows kind, target, measured value against the threshold,
  the suggested CSS with a Copy button, a Show button (scrolls to the element and draws a highlight box inside the
  overlay's own shadow root from `getBoundingClientRect`, writing nothing into the app's DOM), and Undo when a fix was
  applied. It reads `rt.checks?.()` and `on("check")` defensively for older runtimes and `MockRuntime`.
- `@genclass/runtime/visual` also exports `checkPage(options?): Promise<CheckFinding[]>`, report-only and without a
  runtime, for the developer's own Playwright or Cypress tests and for the bench.

### 9.4 Summary, sinks, audit

- `SessionSummary` gains optional keys that appear only once visual has run, so every existing summary (and the sim's
  output) stays byte-identical: `checks?: Partial<Record<CheckKind, number>>`, `fixes?: { applied: number; undone:
  number }`, `visual?: { passes; elements; ms; maxSliceMs; partial; abstained; unsupported: CheckKind[]; tier;
  stopped? }`.
- `SinkKind` gains `"check"`, delivered only to sinks whose `kinds` lists `"check"` (an existing sink without a
  `kinds` filter sees no new record kind). The record carries `check: { kind, severity, fixed }` with `route` and
  `label`; with `evidence: true` it adds `message`, `target` and `selector`, redacted as other evidence is.
- `AuditKind` gains `"fix"`: `fix: { what: "apply" | "undo" | "drop"; checkId; kind; css; reason? }` with `mode` and
  route, and no model fields, so it cannot be confused with a model action.

## 10. Telemetry

Nothing about visual checks is sent until the owner approves the exact fields. Rule 8 says widening what is sent
needs the owner's OK, and the request of 2026-10-13 did not mention telemetry. Until then the telemetry client has no
visual code at all (which also keeps its first-load bytes unchanged).

Proposed fields, counts only:

| field | where | content |
|---|---|---|
| `counts.checks` | summary event | `{ [kind]: n }` |
| `counts.checksByRoute` | summary event | `{ [normalisedRoute]: { [kind]: n } }`, at most 20 routes; the route is the same `normalizePath(pathname)` already sent with decisions |
| `counts.fixes` | summary event | `{ applied, undone }` |
| `runtime.visual` | summary event | `{ passes, ms, partial, tier }` |
| `visual`, `fix` | session event | `"off" \| "local" \| "on"` and a boolean, so counts can be normalised by coverage |

Never sent: selectors, element text, colours, URLs, sizes, per-finding events. When approved: update `TELEMETRY.md`,
both READMEs, the CHANGELOG and the console notice check. Coverage note: telemetry is already off on local hosts and
visual is off on public hosts by default, so counts only come from apps that set `visual: true` in production.

## 11. Runtime fixes and undo

### 11.1 Gate

A fix runs only when all hold, checked when it is applied and again on every status change:

- `visual.fix` allows the kind (`true` means the three v1 fix kinds);
- the effective mode for the page (session, sample, breaker and route, the existing `effectiveMode`) is `guard` or
  `heal`; `heal` alone never turns fixes on, so existing heal installs do not start restyling pages on upgrade;
- the session is sampled in, the tab is visible, no abstain condition holds;
- the kind is not disabled for this session (a developer undo disables it; three undos of any kind disable all
  fixes);
- fewer than 50 fixes on this page.

### 11.2 Two kinds of change

1. **An owned rule** (`text-invisible`). One `CSSStyleSheet` created lazily and adopted with
   `document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]`. The element gets a token
   (`data-genclass-fix="f3"`, space-separated when there are several), and the rule is
   `[data-genclass-fix~="f3"] { color: rgb(75, 85, 99) !important; }` (plus `-webkit-text-fill-color` when that was set).
   Values are colours generated by the chunk, never page text, so the rule cannot inject CSS. The only write to the
   element is that attribute; app classes and inline styles are never touched. Fixes run only after the settle gates
   (section 2.3), which in practice is after hydration, so a framework does not see the attribute as a hydration
   mismatch; the bench (section 15) checks this on the React and Vue templates and compat apps.
2. **Removing one leaked inline declaration** (`pointer-events-leak`, `scroll-lock-stuck`). Only on `html` or `body`,
   only when the declaration is inline: `el.style.removeProperty(name)` after recording its value and priority. This
   restores whatever the app's own stylesheets say (a `!important` override would instead defeat a stylesheet's
   `overflow-x: hidden` and could expose sideways scrolling). Locks set through classes or stylesheets are never
   touched.

After applying, the check re-measures 50 ms later. If the threshold is not cleared (contrast below 4.5:1, or 3:1 for
large text; pointer events still `none`; the page still cannot scroll), the fix is undone with the reason "did not
clear the threshold".

### 11.3 Undo

- **Developer undo**: `finding.fix.undo()`, the devtools Undo button. An owned rule is removed (found by `CSSRule`
  identity) with its token, and the attribute when it becomes empty. A removed inline declaration is put back with its
  value and priority, but only if the element's inline value is still what the fix left (empty); otherwise the app has
  written it since, and undo does nothing. The kind is disabled for the session.
- **Automatic undo of all fixes**: `setMode("observe")`, the breaker dropping to observe, a route change into a scope
  that does not allow fixes, `enabled` turning false, `disable()`, `pause()`, `destroy()`, a `style-src` CSP
  violation during a fix (section 12).
- **Never fight the app**: when the app changes a fixed element's `class` or `style`, or the element is replaced, that
  fix is dropped (an owned rule is removed; a removed inline declaration is forgotten, not restored). When a dialog or
  menu opens while a `pointer-events` or scroll-lock fix is in place, the fix is dropped, because the app now owns
  that value. A re-check may apply the same fix again at most once per page.
- A library that replaces `document.adoptedStyleSheets` with its own list drops the sheet; GenClass re-adopts it at
  most once, then reports "fix removed by the page" and stops.
- Fixes never feed the breaker or any decision. Each apply, undo and drop writes an audit entry of kind `"fix"`.

### 11.4 What is never fixed at runtime

Colour on hover and focus (v1), `object-fit`, `overflow-x: clip`, inserting a viewport meta, `z-index` or DOM
position, focus, ARIA, and any network retry. Each can make a correct page worse. Accessibility overlays that rewrite
pages at runtime are the cautionary precedent (the FTC's April 2025 order against accessiBe): GenClass's main output
is the source change for the developer.

## 12. CSP

- Checks only read, so they need nothing from a Content-Security-Policy.
- The chunk loads from the same place as the runtime: same origin for bundled apps, and the script tag's base URL for
  the CDN build, which needs the same `script-src` entry as the devtools chunk.
- Owned rules use a constructed stylesheet (`new CSSStyleSheet()` and `insertRule`). MDN's `style-src` page says CSSOM
  methods that parse CSS strings are not blocked; it does not mention `replaceSync`, so v1 uses `insertRule`. Inline
  removals use `style.removeProperty`, which MDN describes as not blocked (direct style property changes). Both are
  verified per engine in CI (section 14), not assumed.
- No fallback that needs `unsafe-inline`: no `<style>` element, no `setAttribute("style", ...)`, no `cssText`. The
  devtools fallback to a `<style>` element is not copied.
- Without `adoptedStyleSheets` (Safari before 16.4, Firefox before 101), owned-rule fixes are unavailable and the
  finding says so; checks still run.
- While fixes are active, a `securitypolicyviolation` with a `style-src` directive removes all fixes, disables fixes
  for the session and prints one warning.

## 13. Module layout and first-load size

```
packages/runtime/src/visual/
  start.ts      first-load stub: option resolution, gates up to the import, the CSP buffer (target 300 to 500 B gzip)
  registry.ts   loader override (the script-tag build registers a URL loader)
  index.ts      chunk entry: startVisual(host, opts), checkPage(); the no-layout guard
  scheduler.ts  settle gates, slices, MutationObserver dirty roots, interaction hooks, budgets
  measure.ts    the only file that reads the DOM: snapshots of computed style, rects, scroll and natural sizes
  math.ts       pure: colour parsing, compositing, contrast, geometry, OKLCH lightness search
  checks/*.ts   one pure function per kind: snapshot in, finding or null out
  fix.ts        owned stylesheet, inline removals, the fix ledger and undo
```

- The chunk gets a narrow `VisualHost`: `clock`, `global`, `mode()`, `active()`, `hidden()`, `route()`, `inflight()`,
  `longTasks()`, `errors()`, `describe(el)`, `report(finding)`, `warn`, `log`. It never sees `RuntimeImpl`, so it
  cannot write to the event log, situations, facts, the gate or the model. `describeElement` is passed through the
  host rather than imported, so the chunk shares no module with first load and builds to one file.
- ESM: `start.ts` loads `visualRegistry.loader ?? (() => import("./index.js"))`; a new tsup entry `visual/index`
  (with types) and an `exports["./visual"]` entry let app bundlers split it.
- Script tag: esbuild inlines dynamic imports in IIFE output, which would put the whole chunk in the script tag. A
  global-build plugin marks `./index.js` as external when imported from `src/visual/start.ts` (the same approach as
  `ortExternal`), and `cdn/global.ts` registers a loader for `visual/index.js` relative to the script's base URL, as the
  devtools chunk does.
- Size: `/auto` is about 98.9 KB gzip against the 100 KB limit in `test/bundle.test.ts`, the main entry about 91 KB
  against 92 KB. All message formatting, selector building and colour math stay in the chunk. The limits are raised
  by the measured stub size, with a dated comment as before. Chunk estimate: 6 to 12 KB gzip, loaded once after idle.

## 14. Test plan

No vitest, build or Playwright runs on the Mac (8 GB). Every step is verified in CI on the branch:
`gh workflow run ci.yml --repo genclass-dev/GenClass-lib --ref <branch>`, then `gh run watch <id> --exit-status`.

Unit tests (existing vitest step, no new dependency):

- `test/visual-math.test.ts`: colour parsing for every computed form (`rgb`, `hsl`, `hwb`, `lab`, `lch`, `oklab`,
  `oklch`, `color(srgb ...)`, `color(display-p3 ...)`, `none` components), unparsable input means abstain; alpha
  compositing over a layer chain; WCAG luminance and ratio with the 0.04045 constant and truncation; large-text
  thresholds; the OKLCH lightness search always reaching the target or falling back to `#000`/`#fff`; geometry
  predicates with 1 px and 2 px tolerances; image distortion with the `object-fit` exemptions. Every threshold is a
  named constant with its source in the module header and has a test just above and just below it.
- `test/visual-checks.test.ts`: each check as a pure function over snapshot fixtures in `test/fixtures/visual/*.json`.
  The snapshots are captured once from Chromium by the browser job and committed, so the math runs against real
  computed-style strings. Each kind has planted-fault fixtures and clean controls (sr-only text, gradient text,
  disabled buttons, skeletons, carousels, sticky headers, dark mode).
- `test/visual-scheduler.test.ts` (happy-dom, `FakeClock` from `test/helpers.ts`): no chunk import before `load`;
  none while hidden, then one after it becomes visible; none when `enabled` is false or pending; slices yield at
  `budgetMs` with a fake measure that advances the clock; the session cap stops re-checks; own attribute writes
  trigger nothing; the no-layout guard returns zero findings.
- `test/visual-purity.test.ts`: an import scan over the source text (`src/visual/**` imports nothing but types from
  `situation/`, `decide/`, `model/`, `state/`, `trace/` or `runtime.ts`; those directories never import `src/visual/`;
  `runtime.ts` imports only `src/visual/start.ts`), and a behavioural half in the style of `situation-purity.test.ts`:
  one `setup()` session run twice, visual off and on with a stubbed chunk that reports findings, gives identical
  `stateText(rt.situation(kind).state)` for every trigger kind, identical `history()` and identical decisions.
- Report and option tests: `Report` kind `"check"` prints one line and a collapsed group, never "Situation sent to the
  model", folds beyond 10 lines; `summary()` has no `checks` key when visual is off; a sink with `kinds: ["check"]`
  gets one record per finding without `selector` unless `evidence: true`, a sink without `kinds` gets none; the default
  matrix of 7.2 (including `?genclass-visual=on` never enabling fixes); in Node, `GenClass.init({ visual: true })`
  starts nothing and leaves no pending timers.
- Fix tests (fake sheet where happy-dom lacks `adoptedStyleSheets`): in `observe` with `fix: true` and a finding,
  no sheet change and no `data-genclass-fix` attribute; in `guard`, the fix applies and `setMode("observe")` removes
  it; undo restores `outerHTML` exactly; an app write to the element's `class` drops the fix; audit entries for apply,
  undo and drop.
- `test/bundle.test.ts`: a marker string unique to the chunk is absent from first-load code of `/auto`, the main entry
  and `genclass.global.min.js`; `dist/visual/index.js` exists with no static relative import; the measured stub delta
  is in the `LIMIT_KB` comment.

Browser job (new, `visual-browser` in `.github/workflows/ci.yml`, in parallel with `runtime`):

- Steps: checkout, Node 22 with the npm cache, `npm ci` with `ONNXRUNTIME_NODE_INSTALL=skip`, build the runtime,
  cache `~/.cache/ms-playwright` keyed on the `@playwright/test` version (1.63.0, already a dev dependency),
  `npx playwright install --with-deps chromium firefox webkit`, run
  `npx playwright test --config test/browser/visual/playwright.config.ts`, upload results on failure.
- A separate config from `test/browser/playwright.config.ts`, whose global setup builds the model test app.
- Fixture pages in `test/browser/visual/fixtures/`: one planted fault per element marked with `data-expect="<kind>"`,
  and clean controls. Served by a small static server modelled on `test/browser/server.mjs`, with per-fixture headers
  (strict CSP: `style-src 'self'`, `script-src 'self'`).
- Contexts: 1280 x 800 and 390 x 844, `colorScheme: "dark"`, `forcedColors: "active"`, `deviceScaleFactor: 2`, fonts
  delayed 2 s through route interception. Each spec asserts `visibilityState === "visible"`.
- Assertions: the exact finding set per fixture (every `data-expect` element found with its kind, nothing else);
  on a 10,000-element page, `maxSliceMs <= budgetMs + 4` and zero `longtask` entries during passes; fixes: computed
  colour after a fix meets the threshold, after undo computed style equals the original; CSP: applying a fix gives
  zero `securitypolicyviolation` events and the expected computed colour in Chromium, Firefox and WebKit, or, if an
  engine blocks it, fixes are disabled with one warning and no fallback.
- Engines: Chromium for everything; Firefox and WebKit for the CSP, `adoptedStyleSheets` and `checkVisibility`
  fixtures.

## 15. Measurement plan in CI

A workflow `visual-bench.yml` (manual dispatch and weekly, not on pull requests) with `bench/visual/` (like
`bench/heal/`). It runs on GitHub runners only.

- **Injection from outside (rule 4)**: a harness-only IIFE build of `src/visual` is added with `page.addInitScript` or
  `page.evaluate`, with a harness host that collects findings. Nothing is added to demos, compat apps or templates.
  One extra run per compat app goes through the real integration (`window.GENCLASS_CONFIG = { visual: true }` read
  by `/auto`) to measure stub timing and chunk loading.
- **Clean corpus**: the 6 demos (built with `demos/scripts/build.mjs`, served with `demos/e2e/serve.ts`), the 4
  templates, the 7 compat apps (build and serve definitions from `compat/harness/apps.mjs`, one matrix entry per app).
  Every finding on an unmodified page is a candidate false report. A committed `bench/visual/labels.json` (page, kind,
  selector) records a person's verdict, real or false; unlabelled findings are listed separately and never counted as
  correct. If a check finds a real issue in a demo, it is labelled and the demo is left alone.
- **Seeded faults for recall**: `bench/visual/faults.mjs` (a seeded RNG; `Math.random` is fine in harness code)
  picks visible candidates and applies each fault through a harness stylesheet plus a `data-bench-fault` marker: text
  colour equal to its resolved background, contrast 1.3:1, `pointer-events: none` left on `body`, `overflow: hidden`
  left on `body`, a transparent overlay over a button, a block with `min-width: 130vw`, an image routed to a 404, an
  image at twice its natural aspect, a stylesheet routed to a 404, a font routed to a 404, `[object Object]` and
  `$NaN` in a price, a control under a fixed bubble, a dialog under a sticky header. Recall per kind is detected faults
  over injected faults; false reports outside injected elements are counted on the same pages.
- **Both schemes and widths (scan mode)**: every page runs at 390 and 1280 px, in light and dark, with scripted hover
  and keyboard focus over interactive elements. This covers dark-mode-only and phone-only bugs a single visitor's
  session cannot see.
- **Public sites (sanity check for false reports)**: `bench/visual/sites.json`, about 40 public home pages (news,
  documentation, shops, SaaS landing pages, government, an encyclopedia, code hosting, design-heavy sites). One load
  per site, sequential, no clicks, no forms, no crawling, 1280 x 800, `load` then `fonts.ready` then 3 s, 30 s
  timeout, `bypassCSP: true` so the harness can inject. Bot challenges and failed loads are "not measured", never
  clean. Element crops go to a CI artifact kept 7 days and are never committed. Every finding is a presumed false
  report until a person confirms it from the crop.
- **Cost**: total ms, max slice ms and elements per page, at 1x and with `Emulation.setCPUThrottlingRate` 4.
- **Metrics**: false reports per clean page view next to recall for every kind, and the false-fix rate (fixes applied
  on clean pages, the visual FIR) next to the fix success rate, written to `docs/runtime/RESULTS.md` with date and
  commit.
- **Proposed gates** (owner to agree) before a kind is on by default: 0 false reports on the demos and templates; at
  most 0.05 per compat page; at most 1 confirmed false report per 10 public sites per kind; recall at least 0.9 for
  `text-invisible` and `image-broken` and at least 0.7 for the other kinds; p95 pass time at most 50 ms on the runner;
  at 4x throttling, pass 1 finishes inside the 100 ms pass budget on at least 90% of clean pages; max slice at most
  `budgetMs + 4` ms; 0 false fixes on all clean pages.
- **Later, with the owner's OK**: the 128 apps in `realapps/` as a larger clean corpus (they run on Azure, not in CI).

## 16. Product wording

What to say once v1 ships (README and genclass.dev), in this voice:

> GenClass also measures visual bugs that never throw an error: text you cannot read because it is the same colour as
> its background, images, fonts and stylesheets that failed to load, pages that scroll sideways on a phone, invisible
> layers that swallow clicks, dialogs hidden behind other elements, and leaks such as "[object Object]" or "$NaN".
> Each report names the element, what was measured and the threshold, and suggests a CSS change for that selector.
> These are measured checks with fixed thresholds. The model is not involved and does not look at pixels. With
> `visual: { fix: true }` in guard or heal mode, GenClass can apply three narrow fixes at runtime (a readable text
> colour, a leaked `pointer-events: none`, a stuck scroll lock); each is reversible, and observe mode never changes
> the page.

What it catches today (after v1): the 23 kinds in section 3, in the visitor's own colour scheme, viewport and
browser, on development hosts by default and in production when the app turns it on.

What it does not catch yet, said plainly:

- text over photos, video and gradients (it abstains; the runtime cannot read pixels);
- canvas and WebGL content, glyph-level overlap;
- the colour scheme, viewport or hover state the visitor is not using (the CI scan covers those);
- layout shifts and failed CSS background images outside Chromium (no browser signal);
- low contrast that is readable but below WCAG AA (a later opt-in accessibility tier).

What it is learning (planned, not built): per-app expectations such as "this button is normally visible and clickable
here" (v2), and later a model trained on visual situations (v3, which needs a new model version and new data).

Never say: that GenClass makes a site accessible or WCAG compliant (the FTC's 2025 accessiBe order is the precedent),
that the model "sees" the page, that it fixes CSS bugs automatically in general, or a precision figure that the bench
has not measured.

## 17. Owner decisions and open questions

Owner decisions:

1. **Defaults**: `visual: "local"` (on for development hosts and with devtools mounted, off on public hosts unless
   `visual: true`), and whether `?genclass-visual=on` may enable report-only checks on public hosts.
2. **Fixes**: explicit `visual.fix` plus `guard` or `heal`, and the three v1 fix kinds.
3. **Telemetry**: the fields in section 10 (counts per kind and normalised route), under rule 8.
4. **Sinks**: `"check"` records only for sinks that list it in `kinds`.
5. **Gates**: the numbers in section 15.
6. **CONTRACT.md**: the same rule 2 exception added to CONTRACT section 0 rule 1, and a new section for visual checks,
   when implementation starts.
7. **Public-site bench**: the list of about 40 sites and loading them weekly from GitHub runners.
8. **v3**: a go-ahead for a new situation tag, when v1 and v2 numbers justify it.

Open questions to verify in the browser job: whether `getComputedStyle` exposes Chrome's autofill background; Safari
support for `getComputedStyle(el, "::placeholder")`; `responseStatus` outside Chromium; `insertRule` and
`style.removeProperty` under a strict CSP in each engine; radix-ui/primitives issue 3445 (seen only through a
downstream fix commit) as the cause of the `pointer-events` leak.

## 18. Sources

- WCAG 2.2: relative luminance, contrast ratio, SC 1.4.3, 1.4.10, 2.4.11; https://www.w3.org/TR/WCAG22/
- axe-core color-contrast (background stack, incomplete reasons, issue #4608 on dark canvases):
  https://github.com/dequelabs/axe-core
- Lighthouse `image-aspect-ratio` and `image-size-responsive`: https://github.com/GoogleChrome/lighthouse/tree/main/core/audits
- web.dev CLS (thresholds 0.1 and 0.25, session windows, `hadRecentInput`): https://web.dev/articles/cls
- MDN: `Element.checkVisibility`, `Document.elementsFromPoint`, `PerformanceResourceTiming.responseStatus`,
  `FontFaceSet`, `SecurityPolicyViolationEvent`, `HTMLMediaElement.error`, `Document.adoptedStyleSheets`,
  CSP `style-src`
- CSS Custom Properties Level 1 (invalid at computed-value time): https://www.w3.org/TR/css-variables-1/
- FTC order against accessiBe (2025-04-22): https://www.ftc.gov/
- Repo: `src/model/host.ts` (idle scheduling), `src/observe/perf.ts` (long tasks as `perf` events),
  `src/learn/profiles.ts` (`MIN_COMPLETIONS`, `RARE`), `src/cdn/config.ts` (`fromPairs`, `isLocalHost`),
  `test/bundle.test.ts` (`LIMIT_KB`), `tsup.config.ts` (`ortExternal`)

## 19. v1 implementation notes

What the code does where it differs from the design above (2026-10-13, branch `wave2/visual`):

- **Fixes need `on: true`.** `visual: { on: true, fix: true }` plus guard or heal. `"local"` (the default) and
  `?genclass-visual=on` never fix, on any host.
- **The host is built in the chunk.** To keep first load under 0.5 KB, `src/visual/bridge.ts` (in the lazy chunk)
  builds the `VisualHost` from the runtime object the stub hands over, and reads some members that are private in
  TypeScript only (`reporter`, `sinks`, `fire`, `pushAudit`, `auditBase`, `sessionId`, `sessionTags`, `sampled`,
  `reportMode`, `_aggr`). `test/visual-bridge.test.ts` fails if one is renamed; the engine and the checks see only the
  host. `rt.summary()` gains its `visual` key from the bridge too.
- **Load timing.** The stub imports the chunk 1.5 s after `load` (6.5 s at most when `load` is late), without an idle
  callback of its own (every pass already runs in idle slices). While `enabled` is false or pending it re-checks every
  5 s. The devtools overlay and `rt.checkNow()` load it on demand.
- **`pause()`** undoes fixes at the next 2 s periodic read rather than at once (no first-load code for it);
  `setMode("observe")`, the breaker, `disable()` and `destroy()` undo them at once.
- **One summary key.** `SessionSummary.visual` holds `checks`, `checksByRoute`, `fixes` and the cost fields, instead
  of separate `checks`, `fixes` and `visual` keys. Telemetry sends that object as `visual` in the summary event and
  the setting (`local` or `on`) as `visual` in the session event; there is no separate `fix` field.
- **Folding** is by finding key: elements of the same kind with the same selector fold into one finding.
- **`csp-blocked`** names the element that requested a blocked URL when the event does not.
- **`control-unreachable`** only counts covers up to 40% of the viewport tall (a full-screen invisible layer is
  `click-blocked`'s case).
- **Known gap.** `elementsFromPoint` skips `pointer-events: none` layers, so a background painted by such an overlay
  is not seen by the `text-invisible` resolver.
- **Sizes and costs measured in CI** (GitHub runner, Chromium): first-load growth against main 486 B gzip for `/auto`
  and 431 B for the main entry (`test/first-load-size.mjs`, limit 512 B); the chunk `dist/visual/index.js` is about
  35 KB gzip (the estimate was 6 to 12 KB); a 10,000-element page took 2 passes, 72.9 to 127.8 ms of check time in all
  (two runs), a longest slice of 8.5 ms and no partial pass. On the fixture pages every planted fault was found and
  nothing else was reported (35 faults, 23 kinds; written by the checks' author, so this is not a precision figure).
- **Not built yet:** the bench (`bench/visual/`, `visual-bench.yml`, section 15), the explain step (likely source
  rule, 2.6), the "inserted content" cause tag of `layout-shift`, `genclass-runtime init --no-visual`, Firefox and
  WebKit in the browser job (it runs Chromium only), v2 and v3. No precision or recall figure is measured.
