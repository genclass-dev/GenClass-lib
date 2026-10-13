# Visual and CSS bugs in AI-generated web apps: catalog

Status: research, merged on 2026-10-13 from six read-only research sweeps run the same day, then extended the same day from a gap review of that merge (15 new entries, 1 new minor defect, evidence updates to 8 entries and 2 tier changes). 119 distinct bugs (110 full entries and 9 minor CSS defects), ranked by how common the evidence says they are, in 13 families. Every bug has a fault-injection recipe in [injectors.json](injectors.json) (216 recipes: 178 faults and 38 correct lookalikes for measuring false reports).

The owner asked on 2026-10-13 for more CSS bugs, especially the ones that vibe-coded (AI-generated) sites ship, with a complete search, and for training on our own VMs. This document is the search and the injection side. It does not train anything. The visual checks themselves are designed in `docs/runtime/VISUAL.md` on branch `wave2/visual`; each entry here says whether a v1 kind there covers it, is held back there, or is not in that design.

The network model and its text (`situation-v2.3`) are not touched by anything here.

## Contents

1. [How to read this](#how-to-read-this)
2. [Data sources and how far to trust them](#data-sources-and-how-far-to-trust-them)
3. [Ranked index](#ranked-index)
4. [Unreadable text](#unreadable-text) (5)
5. [Missing or broken media](#missing-or-broken-media) (10)
6. [Missing styles or fonts](#missing-styles-or-fonts) (10)
7. [Layout overflow and clipping](#layout-overflow-and-clipping) (8)
8. [Overlap and occlusion](#overlap-and-occlusion) (9)
9. [Hidden or unreachable controls](#hidden-or-unreachable-controls) (17)
10. [Template and data leaks](#template-and-data-leaks) (8)
11. [Blank page and missing content](#blank-page-and-missing-content) (6)
12. [Motion and shift](#motion-and-shift) (11)
13. [Dark mode](#dark-mode) (5)
14. [Responsive](#responsive) (11)
15. [Alignment, spacing and consistency](#alignment-spacing-and-consistency) (3)
16. [Other](#other) (16)
17. [Design tells (not defects)](#design-tells-not-defects)
18. [Detection and training notes](#detection-and-training-notes)
19. [Gaps](#gaps)

## How to read this

**Ranking.** Bugs are ordered by evidence tier, then within a tier by the strength of the best number. The tiers:

| tier | meaning | bugs |
|---|---|---|
| A | a measured rate of 10% or more in AI-generated pages, repos or audits, or one of the top visual complaints in builder communities (100+ posts) | 15 |
| B | a measured rate under 10% in AI output; or a measured rate in web-wide data or a defect-taxonomy study plus AI-specific reports; or a source pattern present in 10% or more of AI repos that fails only under an extra condition (long text, a toggle, a phone toolbar) | 52 |
| C | documented in issue trackers, Q&A and builder commit history (counts given), with no measured rate of the defect in AI output; an exposure rate may be given when it is under 10% or when the condition that turns it into a defect is rare or unknown | 34 |
| D | anecdotal or mechanism only | 18 |

Rates of a source pattern (exposure) count toward tier A only when the pattern produces the defect on a normal page by itself (no viewport meta, an unsized image, an invented image URL). Easy-to-measure bugs get measured more often, so tier A over-represents mobile layout and accessibility checks; complaint counts (blank screens, the generic look, share previews) partly correct for that.

**Fields.** Each entry gives what renders, why AI-generated code produces it, how common it is (with sources), detection from the DOM in the browser (APIs and cost), false-positive traps, a fault-injection recipe a harness can apply from outside to a correct page (the injector ids point into injectors.json), the developer fix, and sources. Bracketed keys such as [XCompat] refer to the data sources table.

**Detection cost.**

| cost | meaning |
|---|---|
| events | event listeners and property reads; close to free |
| pass | one pass over visible elements with getComputedStyle and getBoundingClientRect (and CSSOM reads where noted); linear in element count, so it runs in slices behind the VISUAL.md section 2.3 settle and persistence gates |
| hit-test | elementFromPoint or elementsFromPoint at several points per target, plus scrolling targets into view; linear in targets and it moves the scroll position, so it runs on interaction or in scan mode |
| scan | needs a second render (another width, colour scheme, input mode, text size or engine), CDP emulation, forced pseudo-states, real input events or pixels; a harness or scan-mode check, not something a visitor's page can do |

**VISUAL.md.** `v1` names the v1 kind that covers the bug; `held back` means VISUAL.md section 4 lists it as waiting for measurements; `not covered` means the design does not mention it. The VISUAL.md column of the index shortens these to v1, held back, partly and no.

## Data sources and how far to trust them

Numbers are as the sweeps reported them on 2026-10-13; only the Unsplash count was re-checked during the merge. During the gap merge, seven URLs that new injectors use were requested once: YouTube oEmbed for 0QeZhC7Y0-4 (404), dQw4w9WgXcQ and jNQXAC9IVRw (200), the BigBuckBunny sample file (403), a Static Maps URL with key=YOUR\_API\_KEY (403), a key-free maps query embed (200 after a redirect) and the Lovable template OG image (200). Vendor and agency figures (OverlayQA, RapidDevelopers, accessiBe, testers.ai) are labelled where used and are indicative only.

| key | what | caveat |
|---|---|---|
| XCompat | arXiv 2608.12518 (Guo et al., 2026): 203 pages generated by MLLMs and agents (8 tools including Cursor and v0) rendered in 9 BrowserStack environments, 2,032 page and environment pairs, two annotators (kappa 0.95). 68% of AI pages had a failure, against 40% of human-written pages. [link](https://arxiv.org/html/2608.12518v1) | The strongest AI-specific study. Percentages are of failing pairs or failing pages, as stated in each entry. |
| Corpus | One sweep's study of 375 AI-builder repos found by GitHub code search (Lovable 160 via lovable-tagger, v0 110 via my-v0-project, bolt.new 110 via .bolt/prompt), HEAD shallow-cloned on 2026-10-13, regex checks at repo level; every remote image URL (1,920) and Google Fonts URL (144) fetched once from one IP that day. | Repo-level regexes, hand-checked on samples; monorepos and templates add noise. Liveness is a one-day snapshot. Scripts and data were not committed (see Gaps). The Unsplash figure (147 of 856) was re-counted from the raw status file while merging. The gap review re-scanned the same repos on 2026-10-13 (377 cloned that time) and checked every YouTube id through YouTube's oEmbed endpoint and every remote video URL once; entries that cite the re-scan say so and use 377. |
| LovCommits | GitHub commit search for author gpt-engineer-app[bot] (Lovable's committer): 42,966,505 commits, 3,843,110 matching fix. Counts are 'fix' plus a keyword. [link](https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix&type=commits) | GitHub stems words and the matches include feature work. Read the counts as relative signals between bugs, not as bug counts. The gap review read its counts through the REST search API. |
| LovCSS | GitHub code search over files carrying Lovable's template text: 30,720 src/index.css files with 'All colors MUST be HSL', 31,744 index.html with 'Lovable Generated Project', 79,360 package.json with lovable-tagger. | Counts only CSS files, not class names in TSX, so they understate utility-class patterns. |
| Reddit | 92,631 posts (title and body, no comments) from r/vibecoding, r/lovable, r/boltnewbuilders, r/base44, r/replit, r/windsurf, r/v0\_, r/cursor and r/nocode, downloaded from the Arctic Shift archive (reddit.com refuses fetches from this environment), counted with strict regexes, crossposts dropped. | Lower bounds: posts only. Precision spot-checked on 15-post samples and given per entry. r/cursor and r/nocode cover only early 2025. The gap review counted 86,113 posts after title dedupe, and added r/ClaudeCode titles through Arctic Shift search for one entry. |
| HN | 29,886 Hacker News comments since 2025-01-01 pulled by 64 visual phrases through the Algolia API; 2,207 are in Show HN threads, where commenters review launched apps. [link](https://hn.algolia.com/api) | Phrase matches, partly verified by reading. |
| v0forum | Topic titles from community.vercel.com (#v0). [link](https://community.vercel.com/) | Titles only. |
| AIStudio | Topic titles from the Google AI Studio forum. [link](https://discuss.ai.google.dev/) | Titles only. |
| Krebs | Adrian Krebs's Playwright scan of about 1,590 Show HN sites with 16 deterministic DOM and computed-style AI-template patterns; 22% (347) hit 4 or more, 32% hit 2 or 3. Detector code is public (design-slop-cop). [link](https://www.adriankrebs.ch/blog/design-slop/) | Design patterns, not defects; about 5 to 10% false positives by the author's estimate. |
| Harvv | Harvv's audit of 85 AI-built sites (Lovable 39, v0 28, Replit 12, Cursor 4, Bolt 2). [link](https://harvv.com/research/lovable-friction-tax) | Single audit; method partly static (for example 'potential dead clicks'). |
| DWC | Design with Claude's audit of 123 AI-generated frontends. [link](https://www.designwithclaude.com/design-research/ai-generated-frontends) | Single audit; categories are broad. |
| WebAIM26 | WebAIM Million 2026: automated WAVE scan of the top million home pages. [link](https://webaim.org/projects/million/) | Web-wide, not AI-specific; the report links the rise in errors to AI-assisted coding. |
| Almanac25 | HTTP Archive Web Almanac 2025 (accessibility and performance chapters); [Almanac24] is the 2024 edition. [link](https://almanac.httparchive.org/en/2025/accessibility) | Web-wide. |
| Suh | arXiv 2503.15885: GPT-4o and Qwen2.5-Coder regenerating 473 files, checked with AChecker. [link](https://arxiv.org/html/2503.15885) | GPT-4o had fewer contrast issues than the human pages it was compared with, so contrast is not AI-specific. |
| A11YN | arXiv 2510.13914: axe-core on LLM-generated UIs (RealUIReq-300); inaccessibility rate 0.27 for GPT-4.1 and 0.29 for Claude Sonnet 4. [link](https://arxiv.org/html/2510.13914v1) |   |
| OwlEyes | arXiv 2009.01417 (ASE 2020): 4,470 of 10,330 mobile crowdtesting screenshots had display issues: occlusion 47%, missing image 25%, text overlap 21%, NULL value 6%, blurred 1%. [Nighthawk] (arXiv 2205.13945) is its follow-up. [link](https://arxiv.org/abs/2009.01417) | Android apps, not AI-generated; useful for issue mix and for its synthetic-injection method. |
| DesignBench | arXiv 2506.06251: repair set of 111 real pages; alignment 42.2%, crowding 18.7%, occlusion 18.1%, overflow 11.4%. Models identified the issue 27% of the time. [link](https://arxiv.org/html/2506.06251v3) | Real pages, not AI-generated. |
| WebGenV | arXiv 2510.15306 (WebGen-V Bench): alignment and spacing were the most frequent low-score categories for Claude Opus 4.1, GPT-5 and Gemini 2.5 Pro. [link](https://arxiv.org/html/2510.15306v1) | Scores of generated sections, not defect rates. |
| WebCompass | arXiv 2604.18224: LLM-injected bugs with inverse patches across 11 types; feature missing is the top generation error. [link](https://arxiv.org/html/2604.18224v1) |   |
| DCGen | arXiv 2406.16386: GPT-4o screenshot-to-code on 12 sites (1,699 elements): 85.34% omitted, 12.71% misarranged, 2.56% distorted. [link](https://arxiv.org/html/2406.16386v3) | Screenshot-to-code task, not vibe-coded apps. |
| UILens | UI-Lens (CVPR 2026): six display-quality categories over about 4,566 pages; general MLLMs reached about 20% F1 on text overflow and 31% on container overlap. [link](https://huggingface.co/datasets/wuhuohua/UI_lens) | Per-category counts not public. |
| SUD | arXiv 2607.04120: 308 Android display bugs triggered by system settings (dark mode 111, rotation 53, font size 37, RTL 19, display size 14). [link](https://arxiv.org/html/2607.04120v1) | Android, not AI-specific; used for the mix of setting-triggered bugs. |
| ReDeCheck | Walsh et al.: responsive layout failure detection; failures in 16 of 26 live sites; 197 of 328 reports were true positives. [link](https://eprints.whiterose.ac.uk/id/eprint/116989/) | Human-built sites. |
| VERVE | Confirms DOM-reported layout failures with an opacity trick and image diff; 86.3% agreement with manual labels; labels true positive, false positive and real but not observable (NOI). [link](https://eprints.whiterose.ac.uk/165542/) |   |
| Walsh | Walsh et al. 2020: 8 HTML and CSS mutation operators for layout regressions. [link](https://eprints.whiterose.ac.uk/163400) |   |
| MFix | Mobile-friendly problem repair (ICSE 2018). [link](https://eprints.whiterose.ac.uk/127563/) |   |
| Boxy | luptonm/boxy: 9 realistic CSS mutants (clipping, off-screen, collapse). [link](https://github.com/luptonm/boxy) |   |
| DiffSpot | arXiv 2605.29615: 13 single-property CSS operators at 3 magnitudes; the best VLM found 40.7% of changes, the median model 4% of line-height changes. [link](https://arxiv.org/html/2605.29615v1) |   |
| MAEWU | 16 live-DOM mutation operators from 250 real web-app bug reports (44% affected the UI). [link](https://people.ece.ubc.ca/amesbah/resources/papers/icsme21.pdf) |   |
| XBIDetective | arXiv 2512.15804: 243 of 1,052 web-compat reports showed a cross-browser inconsistency; a fine-tuned VLM reached 79% accuracy. [link](https://arxiv.org/html/2512.15804v1) |   |
| Halle | Halle et al. (arXiv 1608.07883): 90+ layout bugs on 35 sites, including 1px misalignment and translation overlap. [link](https://arxiv.org/abs/1608.07883) |   |
| SO | Stack Overflow question view counts read through api.stackexchange.com on 2026-10-13. | Views measure how often developers hit a CSS problem in general, not AI output. |

## Ranked index

| # | id | bug | family | tier | headline evidence | VISUAL.md |
|---|---|---|---|---|---|---|
| 1 | [`text-low-contrast`](#1-text-low-contrast) | Low-contrast body text, secondary text and button labels | Unreadable text | A | 83.9% of home pages (WebAIM 2026); 80% of AChecker violations in LLM output; largest Show HN complaint (64) | held back |
| 2 | [`page-overflow-x`](#2-page-overflow-x) | Page scrolls sideways at phone widths | Layout overflow and clipping | A | 23.1% of failing AI page pairs (XCompat); fixed px widths in 82% of repos; 7,713 Lovable fix commits | v1 `page-overflow-x` |
| 3 | [`viewport-meta-missing`](#3-viewport-meta-missing) | Missing or wrong viewport meta (desktop page shrunk onto the phone) | Responsive | A | root cause on 46% of failing AI pages, about 32% of all AI pages (XCompat) | v1 `viewport-meta-missing` |
| 4 | [`layout-not-adapted`](#4-layout-not-adapted) | Desktop layout kept on phones (rows that never wrap, fixed columns, fixed sidebars) | Responsive | A | no flex or grid wrapping on 29.5% of failing AI pages (XCompat); 27+ Reddit posts; 29 Show HN comments | no |
| 5 | [`page-blank`](#5-page-blank) | Blank or white screen instead of the app | Blank page and missing content | A | top builder-forum complaint: 190 Reddit posts, 16 v0 forum topics, about 18k Lovable fix commits | v1 `page-blank` |
| 6 | [`image-broken`](#6-image-broken) | Broken images (invented URLs, dead placeholder hosts, wrong asset paths) | Missing or broken media | A | a dead remote image in 10 to 23% of repos per builder; 17.2% of Unsplash URLs 404 | v1 `image-broken`, `image-css-broken`, `text-placeholder` |
| 7 | [`layout-shift`](#7-layout-shift) | Content jumps while loading (unsized media, late content, font swap) | Motion and shift | A | unsized img tags in 28% of repos; 62% of mobile pages web-wide | v1 `layout-shift` |
| 8 | [`hover-only-controls`](#8-hover-only-controls) | Controls and content visible only on hover | Hidden or unreachable controls | A | hover-only reveals in 35% of repos, 38% of Tailwind v4 repos | no |
| 9 | [`tap-targets-small`](#9-tap-targets-small) | Touch targets too small or too close | Hidden or unreachable controls | A | 29% of 85 AI-built sites (Harvv) | held back |
| 10 | [`focus-indicator-missing`](#10-focus-indicator-missing) | Focus indicator removed with no replacement | Hidden or unreachable controls | A | 19% of repos remove the outline with no ring; about 67% of pages web-wide | held back |
| 11 | [`zoom-disabled`](#11-zoom-disabled) | Pinch zoom blocked by the viewport meta | Responsive | A | 18% of 85 AI-built sites (Harvv); 19 to 21% web-wide | no |
| 12 | [`image-distorted`](#12-image-distorted) | Stretched, squashed or inconsistently cropped images | Missing or broken media | A | 10.8% of failing AI pairs (XCompat); 14% of repos | v1 `image-distorted` |
| 13 | [`reduced-motion-ignored`](#13-reduced-motion-ignored) | Decorative motion that ignores prefers-reduced-motion | Motion and shift | A | about 1 in 3 of 123 AI frontends (DWC) | no |
| 14 | [`placeholder-content`](#14-placeholder-content) | Template placeholder content left visible | Template and data leaks | A | placeholder contact text in 12% of repos | v1 `text-placeholder` |
| 15 | [`share-preview-default`](#15-share-preview-default) | Default or missing social share preview | Template and data leaks | A | default or missing OG image in 72% of Lovable, 94% of v0 and 75% of bolt repos; 72 Reddit posts | no |
| 16 | [`dark-mode-partial`](#16-dark-mode-partial) | Half-applied dark mode (surfaces and text flip separately) | Dark mode | B | 36% of setting-triggered display bugs (SUD); 30% of repos toggle a theme; 14,990 Lovable fixes | v1 `text-invisible` |
| 17 | [`text-invisible`](#17-text-invisible) | Invisible text (foreground equal or nearly equal to background) | Unreadable text | B | 8 Reddit posts, 13 Show HN comments; a review tool's top issue on 30+ apps | v1 `text-invisible` |
| 18 | [`content-stuck-invisible`](#18-content-stuck-invisible) | Content stuck at opacity 0 from scroll-reveal animations | Motion and shift | B | initial opacity 0 in 29% of repos; motion findings on 39% of AI frontends | held back |
| 19 | [`route-scroll-kept`](#19-route-scroll-kept) | A new route opens at the previous page's scroll position | Motion and shift | B | no scroll reset in 78% of client-routed apps (38% of repos); 3,593 Lovable scroll-to-top fixes | no |
| 20 | [`fixed-header-covers`](#20-fixed-header-covers) | Fixed or sticky header covers content, anchor targets and focused controls | Overlap and occlusion | B | 24% of repos: fixed header plus anchors and no scroll offset | v1 `focus-obscured` |
| 21 | [`overlap-elements`](#21-overlap-elements) | Overlapping text and elements | Overlap and occlusion | B | 5.5% of failing AI pairs; occlusion 18.1% (DesignBench); text overlap 21% (OwlEyes) | no |
| 22 | [`text-clipped`](#22-text-clipped) | Text clipped or over-truncated inside fixed boxes | Layout overflow and clipping | B | occlusion including clipping 47% of mobile issues (OwlEyes); MLLMs about 20% F1 | held back |
| 23 | [`misalignment`](#23-misalignment) | Near-miss alignment (edges, baselines, icons, card rows) | Alignment, spacing and consistency | B | 42.2% of real-page display issues (DesignBench); top low-score category for 3 models | no |
| 24 | [`viewport-100vh`](#24-viewport-100vh) | 100vh and h-screen sections cut off on phones | Responsive | B | 100vh in 97% of repos; 33% never use dvh or svh (85% of bolt) | no |
| 25 | [`whitespace-anomaly`](#25-whitespace-anomaly) | Unexpected blank bands | Responsive | B | 13.8% of failing AI pairs (XCompat) | no |
| 26 | [`content-blowout`](#26-content-blowout) | Long content blows out cards and rows (min-width auto, 1fr tracks, unbreakable strings) | Layout overflow and clipping | B | 15% of repos use truncate without min-w-0 | v1 `page-overflow-x` |
| 27 | [`theme-flash`](#27-theme-flash) | Wrong theme painted first (white flash) and theme UI wrong after hydration | Dark mode | B | no pre-paint theme script in 60 client-rendered theme-toggling apps (16% of repos); 7,415 Lovable flash fixes | no |
| 28 | [`llm-markdown-raw`](#28-llm-markdown-raw) | AI answers shown as raw markdown (literal asterisks, # and pipes) | Template and data leaks | B | no markdown renderer in 54 of 73 LLM-calling repos (14% of all); 5,349 Lovable markdown fixes | no |
| 29 | [`css-token-invalid`](#29-css-token-invalid) | Theme tokens that resolve to nothing or to an invalid colour (transparent surfaces) | Missing styles or fonts | B | 19% of v0 repos double-wrap colour tokens; 6 shadcn transparency issues | v1 `css-var-undefined` |
| 30 | [`overlay-behind`](#30-overlay-behind) | Overlays rendered behind other content (z-index and stacking contexts) | Overlap and occlusion | B | z-index 999+ in 18% of repos; 13,674 Lovable fixes | v1 `dialog-covered` |
| 31 | [`fake-affordances`](#31-fake-affordances) | Elements styled as interactive with nothing behind them | Hidden or unreachable controls | B | potential dead clicks on 18% of 85 AI-built sites (Harvv) | no |
| 32 | [`font-not-loaded`](#32-font-not-loaded) | Declared web font never loads or never applies | Missing styles or fonts | B | 12% of repos declare a font they never load; 2.8% of Google Fonts URLs return 400 | v1 `font-failed` |
| 33 | [`forced-colors-focus-lost`](#33-forced-colors-focus-lost) | Focus rings that vanish in Windows contrast themes (outline-none plus a box-shadow ring) | Hidden or unreachable controls | B | 98% of Tailwind v4 shadcn buttons (10% of repos); 1 repo has a forced-colors rule | no |
| 34 | [`overflow-hidden-sticky`](#34-overflow-hidden-sticky) | overflow-x hidden band-aid that clips content and breaks position sticky | Layout overflow and clipping | B | overflow-x hidden in 78% of repos; on the root with sticky elements in 5% | no |
| 35 | [`overlay-left-behind`](#35-overlay-left-behind) | Overlay, backdrop or scroll lock left behind after close or navigation | Hidden or unreachable controls | B | stale visibility in 48 of 308 bugs (SUD); shadcn #5561, 113 reactions | v1 `scroll-lock-stuck`, `click-blocked` |
| 36 | [`empty-controls`](#36-empty-controls) | Buttons and links with no visible label (icon failed or missing) | Hidden or unreachable controls | B | empty links 46.3%, empty buttons 30.6% of home pages | partly `icon-font-failed` |
| 37 | [`placeholder-only-labels`](#37-placeholder-only-labels) | Form fields labelled only by placeholder text | Other | B | missing labels on 51% of home pages | no |
| 38 | [`tailwind-class-missing`](#38-tailwind-class-missing) | Utility classes that generate no CSS (interpolated names, scan paths, invented shades) | Missing styles or fonts | B | interpolated class names in 6% of repos | held back |
| 39 | [`tailwind-version-mix`](#39-tailwind-version-mix) | Tailwind v3 and v4 vocabulary mixed (classes and config the installed version ignores) | Missing styles or fonts | B | v4-only names in 5% of v3 repos; v3 opacity utilities in 14% of v4 repos | held back |
| 40 | [`builder-branding`](#40-builder-branding) | Builder branding and template defaults left on the live site | Template and data leaks | B | default title in 9% of repos ('v0 App' in 16% of v0); 46 Reddit posts | no |
| 41 | [`crowding`](#41-crowding) | Crowding (too little spacing between elements) | Alignment, spacing and consistency | B | 18.7% of real-page display issues (DesignBench) | no |
| 42 | [`design-drift`](#42-design-drift) | Spacing, type and colour drift across repeated components | Alignment, spacing and consistency | B | spacing a top low-score category (WebGen-V); 34 Reddit posts, about 45% on topic | no |
| 43 | [`text-too-small`](#43-text-too-small) | Text too small on phones | Unreadable text | B | 20 Show HN comments | no |
| 44 | [`button-label-nowrap`](#44-button-label-nowrap) | Button labels that cannot wrap, or wrap unevenly | Layout overflow and clipping | B | nowrap in 291 of 294 shadcn buttons; fails only with long labels | no |
| 45 | [`fixed-trapped-by-transform`](#45-fixed-trapped-by-transform) | Fixed overlays trapped inside a transformed, filtered or blurred ancestor | Overlap and occlusion | B | backdrop-blur in 71% of repos; reproduced in Chrome | no |
| 46 | [`tailwind-plugin-missing`](#46-tailwind-plugin-missing) | Plugin classes used without the plugin (prose, animate-in) | Missing styles or fonts | B | prose without the typography plugin in 8% of repos | no |
| 47 | [`scroller-hidden-scrollbar`](#47-scroller-hidden-scrollbar) | Horizontal rows with the scrollbar hidden | Hidden or unreachable controls | B | hidden-scrollbar scrollers in 8% of repos; 3.2M-view Stack Overflow question | no |
| 48 | [`svg-icon-sizing`](#48-svg-icon-sizing) | Icons at the wrong size (no viewBox, no width and height, squeezed in flex rows) | Missing or broken media | B | 7.6% of inline SVGs lack viewBox (10% of repos) | no |
| 49 | [`emoji-as-icons`](#49-emoji-as-icons) | Emoji used as UI icons, and flag emoji on Windows | Other | B | emoji in markup in 63% of repos; flag emoji in 5% | no |
| 50 | [`color-scheme-missing`](#50-color-scheme-missing) | Dark UI without color-scheme (light native controls, scrollbars and overscroll) | Dark mode | B | 30% of repos toggle themes; 24% mention color-scheme | no |
| 51 | [`text-over-image`](#51-text-over-image) | Text over images, gradients or glass with no guaranteed backdrop | Unreadable text | B | glassmorphism is one of Krebs's 16 patterns; backdrop-filter in 12% of Lovable CSS | held back |
| 52 | [`template-text-leak`](#52-template-text-leak) | Literal null, undefined, NaN, [object Object] or template syntax rendered | Template and data leaks | B | NULL value 6% of mobile display issues (OwlEyes) | v1 `text-template-leak` |
| 53 | [`text-scaling-breaks`](#53-text-scaling-breaks) | Layout breaks under larger text, browser zoom or text-spacing settings | Responsive | B | 51 of 308 setting bugs (SUD) | no |
| 54 | [`mobile-nav-missing`](#54-mobile-nav-missing) | Mobile navigation missing, not wired, or impossible to close | Hidden or unreachable controls | B | 2.2% of failing AI pages; 6,853 Lovable mobile-menu fixes | no |
| 55 | [`content-hidden-mobile`](#55-content-hidden-mobile) | Content hidden on phones with no replacement | Responsive | B | 2.2% of failing AI pages (XCompat) | no |
| 56 | [`video-failed`](#56-video-failed) | Hero and background videos that never play | Missing or broken media | B | autoplay without muted in 8 of 26 autoplay repos; 3 of 7 remote video sources dead | partly `media-failed` |
| 57 | [`breakpoint-gaps`](#57-breakpoint-gaps) | Failures at in-between widths and narrow width ranges | Responsive | B | responsive failures in 16 of 26 live sites (ReDeCheck) | no |
| 58 | [`rtl-and-translation`](#58-rtl-and-translation) | Layout breaks under RTL or translated text length | Responsive | B | 28,200 physical against 43 logical direction utilities | no |
| 59 | [`overflow-100vw`](#59-overflow-100vw) | 100vw and w-screen sections overflow by the scrollbar width | Layout overflow and clipping | B | w-screen or 100vw in 8% of repos | v1 `page-overflow-x` |
| 60 | [`icon-missing`](#60-icon-missing) | Icons that do not exist (hallucinated names, unloaded icon fonts) | Missing or broken media | B | nonexistent lucide imports in 1% of repos; name lookups in 8% | v1 `icon-font-failed` |
| 61 | [`embed-placeholder-video`](#61-embed-placeholder-video) | Placeholder YouTube embeds that play Rick Astley | Template and data leaks | B | 23 Reddit posts; the rickroll id in 4 of 16 repos with YouTube ids | no |
| 62 | [`embed-unavailable`](#62-embed-unavailable) | Embedded videos and maps that show an error panel | Missing or broken media | B | 7 of 173 YouTube ids dead, in 4 of 16 repos that use them; 2 repos load Maps with key=YOUR\_API\_KEY | partly `image-broken` |
| 63 | [`gradient-text-invisible`](#63-gradient-text-invisible) | Gradient text that turns invisible or loses its descenders | Unreadable text | B | bg-clip-text in 32% of repos; gradient missing in 1% | no |
| 64 | [`content-omitted`](#64-content-omitted) | Sections or components missing relative to the design | Blank page and missing content | B | 85% of elements omitted in GPT-4o screenshot-to-code (DCGen) | no |
| 65 | [`dark-variant-wrong-signal`](#65-dark-variant-wrong-signal) | Tailwind v4 dark: variant follows the OS while the app toggles a class | Dark mode | B | 2 of 42 Tailwind v4 repos | no |
| 66 | [`duplicate-chrome`](#66-duplicate-chrome) | Two headers, two footers or a repeated section | Blank page and missing content | B | 1,504 Lovable duplicate-header fixes; 2 of 377 repos at HEAD | no |
| 67 | [`cross-browser`](#67-cross-browser) | Rendering differs between Chromium, WebKit and Gecko | Other | B | cross-browser-only failures on 1.0% of AI pages (XCompat) | no |
| 68 | [`pointer-events-stuck`](#68-pointer-events-stuck) | Page frozen: body left at pointer-events none after an overlay closes | Hidden or unreachable controls | C | Radix #1241: 47 reactions, 108 comments; 2,748 Lovable fixes | v1 `pointer-events-leak` |
| 69 | [`dialog-unreachable`](#69-dialog-unreachable) | Dialog or sheet taller than the viewport with no way to scroll | Hidden or unreachable controls | C | shadcn #16: 151 reactions | v1 `dialog-covered` |
| 70 | [`stylesheet-not-applied`](#70-stylesheet-not-applied) | Whole page renders with browser defaults (stylesheet missing or Tailwind setup broken) | Missing styles or fonts | C | Tailwind #16429: 110 upvotes; 10 v0 forum topics; about 13 Reddit posts | v1 `stylesheet-failed` |
| 71 | [`spa-deep-link-404`](#71-spa-deep-link-404) | Direct links and page refreshes show the host's 404 page | Blank page and missing content | C | 925k-view Stack Overflow question; 1,217 Lovable fixes; no fallback in 70% of client-routed apps (exposure) | no |
| 72 | [`stale-chunk-blank`](#72-stale-chunk-blank) | After a redeploy, open tabs go blank or show an error on the next navigation | Blank page and missing content | C | Vite #11804: 236 reactions; none of 24 lazy-routed repos handles a failed chunk | partly `page-blank` |
| 73 | [`scrollbar-shift`](#73-scrollbar-shift) | Scroll lock side effects: the page jumps sideways, or the page behind scrolls | Motion and shift | C | shadcn #4227, Radix #1925; 6,366 Lovable scrollbar fixes | no |
| 74 | [`ios-input-zoom`](#74-ios-input-zoom) | iOS zooms the page on input focus (form text under 16px) | Responsive | C | 905k-view Stack Overflow question; one QA post finds it in almost every Lovable app | no |
| 75 | [`click-blocked`](#75-click-blocked) | Invisible layer intercepts clicks | Hidden or unreachable controls | C | 1,502 'not clickable' Lovable fixes | v1 `click-blocked` |
| 76 | [`fixed-bar-covers-controls`](#76-fixed-bar-covers-controls) | Fixed bottom bars, banners and widgets cover controls | Overlap and occlusion | C | HN and Reddit reports; pop-ups the top miss source in XBIDetective | v1 `control-unreachable` |
| 77 | [`fouc-late-css`](#77-fouc-late-css) | Flash of unstyled content from late CSS (client navigation, Play CDN) | Motion and shift | C | Next.js #17464: 281 reactions | no |
| 78 | [`css-order-dev-prod`](#78-css-order-dev-prod) | CSS cascade order differs between dev and production | Missing styles or fonts | C | Next.js #64921 and Vite #3924: 78 and 107 reactions | no |
| 79 | [`tailwind-v4-defaults`](#79-tailwind-v4-defaults) | Tailwind v4 default changes rendered against v3 habits (cursor, borders, rings, container, scales) | Missing styles or fonts | C | shadcn #6843: 130 reactions | no |
| 80 | [`popover-clipped`](#80-popover-clipped) | Dropdowns, tooltips and date pickers clipped by an overflow ancestor | Overlap and occlusion | C | 3 of 9 Boxy mutants; 3,483 Lovable fixes | held back |
| 81 | [`export-render-broken`](#81-export-render-broken) | PDF, image and print output that fails, comes out blank or gets cut off | Other | C | 201 oklch issues and PRs against html2canvas forks; html2canvas in 4% of repos; 5,536 Lovable PDF-export fixes | no |
| 82 | [`scroll-jank`](#82-scroll-jank) | Laggy scrolling from stacked blur, glow blobs, animated backgrounds and layout animations | Motion and shift | C | several Show HN reviews; non-composited animations on 40% of pages | no |
| 83 | [`scroll-hijack`](#83-scroll-hijack) | Scroll hijacking, pinned sections and scroll-snap traps | Motion and shift | C | most frequent issue in a YC review of vibe-coded sites; the libraries in 2% of repos | no |
| 84 | [`interaction-states-missing`](#84-interaction-states-missing) | Hover, active and disabled states missing or overridden by !important | Hidden or unreachable controls | C | !important in 9.1% of Lovable CSS; every tool failed the LogRocket trap | no |
| 85 | [`inner-pane-no-scroll`](#85-inner-pane-no-scroll) | Full-height app shell whose inner pane grows instead of scrolling | Layout overflow and clipping | C | 702k-view Stack Overflow question | no |
| 86 | [`chart-zero-size`](#86-chart-zero-size) | Charts and maps rendered at zero size | Missing or broken media | C | shadcn #8547: dashboard block blank about 1 load in 10 | no |
| 87 | [`webgl-canvas-blank`](#87-webgl-canvas-blank) | 3D and WebGL heroes with no fallback when WebGL fails | Missing or broken media | C | WebGL libraries in 6% of repos, 1 of 24 handles a failure | no |
| 88 | [`touch-click-through`](#88-touch-click-through) | Select option tap activates the element behind it | Hidden or unreachable controls | C | Radix #1658: 117 reactions | no |
| 89 | [`popover-in-dialog-no-scroll`](#89-popover-in-dialog-no-scroll) | Popover or combobox list inside a dialog will not scroll | Hidden or unreachable controls | C | shadcn #6988 and related issues | no |
| 90 | [`calendar-version-mismatch`](#90-calendar-version-mismatch) | Component code written for an older major version of its library (shadcn Calendar v8 API on react-day-picker v9) | Missing styles or fonts | C | v8 Calendar API on v9 in 9 of 247 repos with a calendar, 1 of them rendered | no |
| 91 | [`bootstrap-version-mix`](#91-bootstrap-version-mix) | Bootstrap 4 markup on Bootstrap 5 pages (dead navbar toggler, ignored spacing classes) | Missing styles or fonts | C | about 2% of Bootstrap 5 pages on GitHub with a collapse use the v4 data-toggle | no |
| 92 | [`extra-scrollbars`](#92-extra-scrollbars) | Extra, nested or always-visible scrollbars | Layout overflow and clipping | C | 4 Reddit posts | no |
| 93 | [`safe-area-keyboard`](#93-safe-area-keyboard) | Fixed bars under the notch, home indicator or on-screen keyboard | Responsive | C | 4 Reddit posts from App Store builds | no |
| 94 | [`missing-ui-states`](#94-missing-ui-states) | Missing empty, loading and error states | Blank page and missing content | C | vendor and practitioner reports | no |
| 95 | [`visual-regression-after-edit`](#95-visual-regression-after-edit) | Visual regressions after an AI edit | Other | C | 11 Reddit posts plus about 20 saying each fix breaks something | no |
| 96 | [`js-breakpoint-flash`](#96-js-breakpoint-flash) | Layout chosen by a JS breakpoint hook (desktop layout flashes on phones) | Motion and shift | C | shadcn useIsMobile reports desktop on first render | no |
| 97 | [`next-image-fill-escapes`](#97-next-image-fill-escapes) | next/image fill escapes its box | Overlap and occlusion | C | Next.js #18739 and a runtime warning | no |
| 98 | [`unexpected-hidden`](#98-unexpected-hidden) | Controls hidden or collapsed by a wrong state class | Hidden or unreachable controls | C | Boxy mutants; MAEWU appearance bugs | no |
| 99 | [`mojibake`](#99-mojibake) | Mojibake and replacement characters | Template and data leaks | C | 2 Reddit posts; none in a source scan of 377 repos | v1 `text-encoding` |
| 100 | [`image-blurry`](#100-image-blurry) | Blurry upscaled images | Missing or broken media | C | 1% of mobile issues (OwlEyes); 448 Lovable fixes | no |
| 101 | [`focus-behind-overlay`](#101-focus-behind-overlay) | Popups and drawers that cover the page but leave focus behind them | Hidden or unreachable controls | C | 2 Lovable storefront audits (vendor) | no |
| 102 | [`links-indistinguishable`](#102-links-indistinguishable) | Inline links indistinguishable from body text | Other | D | Preflight mechanism | no |
| 103 | [`color-only-state`](#103-color-only-state) | State conveyed by colour only (sale prices, errors, statuses) | Other | D | 1 storefront audit (vendor) | no |
| 104 | [`starter-template-css`](#104-starter-template-css) | Starter-template CSS left in place (Vite centring, Next colour-scheme defaults) | Template and data leaks | D | template mechanism | no |
| 105 | [`prose-unthemed`](#105-prose-unthemed) | Tailwind prose left in light colours on a dark page | Dark mode | D | 1 HN thread | v1 `text-invisible` |
| 106 | [`text-occluded-by-decoration`](#106-text-occluded-by-decoration) | Text painted over by decorative layers | Overlap and occlusion | D | HN Firefox reports, undiagnosed | partly `text-invisible` |
| 107 | [`floating-offscreen`](#107-floating-offscreen) | Floating menu or tooltip opened off screen | Overlap and occlusion | D | Boxy mutants | no |
| 108 | [`stat-counter-zero`](#108-stat-counter-zero) | Animated stat counters frozen at 0 | Motion and shift | D | counters in 4% of repos; the failure is mechanism only | no |
| 109 | [`exit-animation-skipped`](#109-exit-animation-skipped) | Exit animations skipped or overlapping (AnimatePresence) | Motion and shift | D | 59 motion issues | no |
| 110 | [`csp-blocked`](#110-csp-blocked) | Images, fonts and styles blocked by the site's own Content-Security-Policy | Missing or broken media | D | a CSP in 2% of repos, none blocking its own assets | v1 `csp-blocked` |
| 111 | [`sticky-hover-touch`](#111-sticky-hover-touch) | Hover lift and colour stuck after a tap on touch screens | Other | D | minor CSS defect, see the table | no |
| 112 | [`translate-blur`](#112-translate-blur) | translate(-50%, -50%) centring blurs text | Other | D | minor CSS defect, see the table | no |
| 113 | [`safari-radius-flash`](#113-safari-radius-flash) | Rounded overflow-hidden corners flash square during transform in Safari | Other | D | minor CSS defect, see the table | no |
| 114 | [`inline-image-gap`](#114-inline-image-gap) | Inline image baseline gap | Other | D | minor CSS defect, see the table | no |
| 115 | [`background-tiling`](#115-background-tiling) | Background images tiling on large screens | Other | D | minor CSS defect, see the table | no |
| 116 | [`vendor-selector-group`](#116-vendor-selector-group) | Grouped vendor-prefixed selectors drop the whole rule | Other | D | minor CSS defect, see the table | no |
| 117 | [`light-image-edge`](#117-light-image-edge) | Light images blend into the page | Other | D | minor CSS defect, see the table | no |
| 118 | [`bg-attachment-fixed-ios`](#118-bg-attachment-fixed-ios) | background-attachment fixed parallax broken on iOS | Other | D | minor CSS defect, see the table | no |
| 119 | [`sticky-chrome-short-viewport`](#119-sticky-chrome-short-viewport) | Stacked sticky and fixed bars eat short viewports | Other | D | minor CSS defect, see the table | no |

## Unreadable text

Text that renders but cannot be read: too little contrast, the same colour as its background, too small, or over an unknown backdrop.

<a name="1-text-low-contrast"></a>

### 1. Low-contrast body text, secondary text and button labels

`text-low-contrast` | tier A | VISUAL.md: held back (VISUAL.md section 4: opt-in accessibility tier) | injectors: `contrast-muted-light`, `contrast-muted-dark`, `contrast-button-500`

- **Renders:** Grey-on-white or grey-on-near-black copy, faint captions and placeholders, and white labels on mid-tone (500-shade) buttons and badges, below WCAG 4.5:1 (3:1 for large text). Readable for some visitors, not for others.
- **Why AI-generated code does it:** Models default to muted tokens (text-muted-foreground, gray-400/500, text-white/40) for secondary copy and express hierarchy by dimming text instead of size or weight. Dark-only themes ship medium-grey body text. Pairs such as bg-blue-500 text-white are among the most common in training data. Nothing in the generation loop measures contrast. This is not unique to AI code: [Suh] found GPT-4o output had about 49% fewer contrast issues than the human-written pages it was compared with.
- **How common:**
  - [WebAIM26]: low-contrast text on 83.9% of home pages (79.1% in 2025); average errors per page up 10.1% to 56.1. The report connects the rise to AI-assisted coding.
  - [Suh] (GPT-4o and Qwen2.5-Coder on 473 files): contrast was about 80% of AChecker violations. [A11YN]: color-contrast is the second most common axe violation in LLM-generated UIs (702 in base outputs).
  - [HN] Show HN threads: 64 comments about grey text, low contrast or hard-to-read text, the largest visual complaint there. [Krebs] scores two dark-theme contrast patterns. [DWC]: contrast findings on 12% of 123 AI frontends.
  - [Reddit]: 12 strict-match posts (about 80% on topic). [LovCommits]: 13,827 'fix contrast', 5,627 'fix text visibility'.
  - [Almanac25]: about 30% of sites pass the Lighthouse contrast audit.
  - Computed WCAG ratios for Tailwind v3 colours: gray-400 on white 2.54:1, slate-400 on white 2.56:1, gray-500 on gray-900 3.67:1, zinc-500 on zinc-950 about 4.1:1, zinc-600 on zinc-950 about 2.6:1. White on blue-500 3.68:1, green-500 2.28:1, emerald-500 2.54:1, orange-500 2.80:1, sky-500 2.77:1, indigo-500 4.47:1. The 600 shades pass behind white (blue-600 5.17:1, indigo-600 6.29:1); gray-500 on white passes at 4.83:1.
- **Detection (cost: pass):** For each visible text element (VISUAL.md 2.1), resolve the effective background with the VISUAL.md 2.4 resolver (elementsFromPoint plus alpha compositing), multiply the text colour's alpha by the ancestor opacity chain, and compute the WCAG 2.2 ratio (VISUAL.md 2.5). Threshold 4.5:1, or 3:1 at 24px and up or 18.66px bold and up. Weight by role: body copy and primary button labels first. Run hover and focus states with forced pseudo-states in scan mode. [Krebs]'s design-slop-cop samples text of 12 to 20px under weight 600 and flags a dark page when 12% or more of at least 5 samples fall under 7:1 with background luminance under 0.2; that rule is a page-level design score, not a defect.
- **False-positive traps:** Disabled controls, placeholders and logos are exempt under WCAG. Text over images, gradients, video and glass needs pixel sampling (the resolver abstains). Screen-reader-only text. Text mid fade-in (persistence gate). text-shadow outlines that improve legibility. Do not flag the 4.5 to 7 band. Flag the computed value, never a class name: default shadcn muted-foreground passes.
- **Fault injection:** Set paragraphs to #9ca3af on a white section, or #52525b on #09090b; or set a primary button to background #3b82f6 with white 14 to 16px regular text.
- **Fix:** Use foreground tokens for body copy and keep muted tokens for secondary text; check ratios in both themes; use 600 or 700 shades behind white labels.
- **Sources:** <https://webaim.org/projects/million/>; <https://almanac.httparchive.org/en/2025/accessibility>; <https://arxiv.org/html/2503.15885>; <https://arxiv.org/html/2510.13914v1>; <https://www.adriankrebs.ch/blog/design-slop/>; <https://raw.githubusercontent.com/AdrianKrebs/design-slop-cop/main/src/patterns/perma-dark-mode.js>; <https://www.designwithclaude.com/design-research/ai-generated-frontends>; <https://news.ycombinator.com/item?id=47865444>; <https://www.reddit.com/r/vibecoding/comments/1nf3slk/>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+contrast&type=commits>; <https://accessibe.com/accessibility-platform/reports/gen-ai-ecommerce/accessibility-audit>

<a name="17-text-invisible"></a>

### 17. Invisible text (foreground equal or nearly equal to background)

`text-invisible` | tier B | VISUAL.md: v1 `text-invisible` | injectors: `text-color-equals-bg`, `text-white-on-white-card`, `control-sr-only-text`

- **Renders:** White text on white cards or buttons, dark text on dark panels; buttons look blank; elements appear to be missing.
- **Why AI-generated code does it:** Hard-coded utilities (text-white, bg-white) mixed with theme tokens; components generated one at a time with different assumptions about the background; a theme switch that flips only one side of the pair. The WebSight dataset authors saw generated text coloured the same as its background.
- **How common:**
  - [Reddit]: 4 strict-match plus 4 verified posts (a Lovable user spent credits re-asking for white-on-white buttons to be fixed). A design-review tool run on 30+ vibe-coded apps reported nearly invisible buttons as its top issue. [HN] Show HN: 13 comments (white sidebar with white text, white text on a white fade).
  - [LovCommits]: 12,564 'fix "not visible"' (mixed), 887 'fix "black text"'. A GitHub PR documents white-on-white buttons and 2.23:1 links from a theme conflict.
- **Detection (cost: pass):** Same contrast routine as `text-low-contrast`; under 1.5:1 against a fully known solid background is invisible (VISUAL.md v1 threshold), checked at rest, hover and focus. When an ancestor has a background image or gradient, abstain in page and sample a screenshot in the harness.
- **False-positive traps:** sr-only text, honeypot fields, bg-clip-text gradient headings (colour transparent on purpose), placeholders and disabled text, text revealed on hover, text mid fade.
- **Fault injection:** Set an element's color to its resolved effective background colour (VISUAL.md bench fault), or set .card{background:#fff} with .card \*{color:#fff}.
- **Fix:** Paired semantic tokens; never set only one side of a colour pair; test both themes.
- **Sources:** <https://www.reddit.com/r/lovable/comments/1nemli7/>; <https://www.reddit.com/r/vibecoding/comments/1o104ht/>; <https://news.ycombinator.com/item?id=48897182>; <https://github.com/cacack/my-family/pull/960>; <https://arxiv.org/html/2403.09029v1>

<a name="43-text-too-small"></a>

### 43. Text too small on phones

`text-too-small` | tier B | VISUAL.md: not covered | injectors: `text-tiny-mobile`

- **Renders:** Body, label or meta text under 12px on a phone; mobile text sometimes smaller than desktop; unreadable when zoom is blocked.
- **Why AI-generated code does it:** Dense dashboard styling (text-xs, text-[10px], 13px console fonts) carried to mobile; no type scale per breakpoint; shrink-to-fit when the viewport meta is missing.
- **How common:**
  - [HN] Show HN: 20 comments say text or UI is too small; a slop-UI thread notes models packing in large amounts of tiny text. [XCompat] shrink-to-fit (42.1% of failing pairs) mostly from a missing viewport meta.
  - Base44 audit guides and a vibecoding scanner output list it; a daily.dev thread mentions 10px text. [MFix] treats hard-to-read text as a core mobile-friendly problem class.
- **Detection (cost: pass):** At 360 to 390px: visible text with computed font-size times visualViewport.scale under 12px; flag body copy under 14px; compare with the desktop render for text that shrinks on mobile.
- **False-positive traps:** Legal footers, superscripts, badges, chart labels, icon fonts.
- **Fault injection:** Inject body,p,li{font-size:11px} at max-width 767px.
- **Fix:** A mobile type scale with a 16px body and nothing under 12px.
- **Sources:** <https://news.ycombinator.com/item?id=47670290>; <https://news.ycombinator.com/item?id=48871666>; <https://arxiv.org/html/2608.12518v1>; <https://www.reddit.com/r/Base44/comments/1riyqgz/>; <https://eprints.whiterose.ac.uk/127563/>

<a name="51-text-over-image"></a>

### 51. Text over images, gradients or glass with no guaranteed backdrop

`text-over-image` | tier B | VISUAL.md: held back (VISUAL.md section 4: the runtime cannot read pixels) | injectors: `hero-scrim-removed`, `glass-over-light`

- **Renders:** Hero copy over photos, gradient sections or translucent blurred cards is unreadable where the backdrop is light, changes as content scrolls behind glass, and turns invisible when the image fails and the white fallback shows under white text. A nested glass panel inside another backdrop-filter shows no blur in Chrome.
- **Why AI-generated code does it:** Gradients, glows and glassmorphism (bg-white/5 with backdrop-blur) are default AI styles; scrims and fallback background colours are left out.
- **How common:**
  - [Krebs]: glassmorphism is one of two CSS patterns in his scan; design-slop-cop detects backdrop blur of 2px or more with background alpha 0.02 to 0.9 on 150 to 820px cards. [LovCSS]: 12% of Lovable index.css files use backdrop-filter. [WebGenV] scores readability as a recurring low-score category.
  - An [HN] commenter notes glass-heavy Tailwind designs almost always fail WCAG. Stack Overflow 60997948 (nested backdrop-filter in Chrome) about 39k views.
- **Detection (cost: scan):** In the harness: for text whose painted background is an image, gradient or backdrop-filter layer, screenshot the region with the text hidden (color transparent), sample pixels behind the glyph boxes across a few frames, and compute the worst-case contrast; also compute contrast against the fallback background-color for a failed image. In page, only gradient stops are readable.
- **False-positive traps:** Scrims that provide contrast; large text at 3:1; decorative text; high-alpha panels over solid backgrounds; animated backgrounds (sample several frames).
- **Fault injection:** Remove the dark overlay from a hero image and swap in a light photo; or set cards to background:rgba(255,255,255,.08);backdrop-filter:blur(8px);color:#e5e7eb over a light gradient.
- **Fix:** Scrim or gradient overlay behind text, a background-color fallback, glass alpha 0.7 or more, text on opaque surfaces.
- **Sources:** <https://www.adriankrebs.ch/blog/design-slop/>; <https://raw.githubusercontent.com/AdrianKrebs/design-slop-cop/main/src/patterns/glassmorphism.js>; <https://arxiv.org/html/2510.15306v1>; <https://stackoverflow.com/questions/60997948>; <https://defensivecss.dev/tips/>; <https://news.ycombinator.com/item?id=49867038>

<a name="63-gradient-text-invisible"></a>

### 63. Gradient text that turns invisible or loses its descenders

`gradient-text-invisible` | tier B | VISUAL.md: not covered (`text-invisible` abstains on background images) | injectors: `gradient-text-no-bg`, `gradient-text-descender`

- **Renders:** Headings with bg-clip-text text-transparent go fully blank when the gradient does not apply (class not generated, a v4 name in a v3 project, a later background shorthand override, a dark-mode reset); with leading-none or leading-tight on inline-block spans the bottoms of g, j, p, q and y are cut off. A probe gave computed colour rgba(0,0,0,0) and background-image none.
- **Why AI-generated code does it:** Gradient headlines are a signature AI landing style, and transparent text has no fallback colour. Tailwind's own bg-clip-text example uses leading-none.
- **How common:**
  - [Corpus]: bg-clip-text in 121 of 375 repos (32%); the same class string missing any gradient in 3 (1%). [LovCSS]: 2,720 of 30,720 Lovable index.css files (8.9%) contain background-clip: text. [Krebs] and Hallmark list gradient headlines among AI patterns.
  - A Codecourse tutorial documents descender clipping; Ghost forum report.
- **Detection (cost: pass):** Elements with computed background-clip text (or -webkit-background-clip) and color or -webkit-text-fill-color alpha 0: background-image none means invisible text. For descenders: line-height / font-size under 1.15, display inline-block, text containing g, j, p, q or y, and element height under font-size times 1.2 (or compare glyph ink bounds in a screenshot).
- **False-positive traps:** Transparent text used for selection overlays; SVG text; elements still animating a gradient in; visually-hidden patterns use clip, not transparent colour.
- **Fault injection:** On a gradient h1 keep color:transparent and background-clip:text but set background-image:none; or set line-height:0.9 with display:inline-block on a gradient heading containing 'gy'.
- **Fix:** A solid fallback colour (@supports), keep the gradient in the same rule, pb-1 or looser leading for descenders.
- **Sources:** <https://codecourse.com/articles/how-to-create-gradient-text-with-tailwind>; <https://tailwindcss.com/docs/background-clip>; <https://forum.ghost.org/t/gradient-issue-with-header/28478>; <https://instagit.com/Nutlope/hallmark/what-are-the-named-ai-slop-anti-patterns.md>

## Missing or broken media

Images, icons and charts that fail to load, never existed, or render at the wrong size or shape.

<a name="6-image-broken"></a>

### 6. Broken images (invented URLs, dead placeholder hosts, wrong asset paths)

`image-broken` | tier A | VISUAL.md: v1 `image-broken`, `image-css-broken`; dead hosts also feed `text-placeholder` | injectors: `image-route-404`, `image-invented-unsplash`, `image-dead-placeholder-host`, `image-css-background-404`, `control-image-lazy-offscreen`

- **Renders:** Broken-image icons, alt text, or empty boxes where heroes, cards, avatars and logos should be; boxes collapse when the image has no size; text placed over the image becomes unreadable. Often fine in the builder preview and broken after deploy.
- **Why AI-generated code does it:** Four causes. (1) Models write Unsplash photo URLs from memory: memorized ids are alive, invented ones 404. bolt.new's default prompt asks for Unsplash URLs the model knows exist. (2) Training data is full of retired placeholder services. (3) Asset paths that work in dev break after build: src/assets/... referenced by path (Vite hashes it), relative paths on nested routes, case-sensitive file names on Linux hosts, uploads kept in ephemeral preview storage. (4) Hotlinked images behind hotlink protection or private buckets, and guessed Wikimedia thumbnail paths.
- **How common:**
  - [Corpus], every remote image URL checked once on 2026-10-13: 147 of 856 Unsplash photo URLs (17.2%) and 136 of 566 unique Unsplash ids (24%) returned 404; 20 of 50 repos that use Unsplash (40%) had at least one dead one. Each dead id appeared in exactly one repo. Repos with at least one dead remote image of any host: bolt 25 of 110 (23%), Lovable 20 of 157 (13%), v0 11 of 108 (10%). Dead rates by host: upload.wikimedia.org 11 of 31, res.cloudinary.com 9 of 20, storage.googleapis.com 16 of 230.
  - Placeholder hosts on 2026-10-13: dead were source.unsplash.com (503, retired June 2024), placehold.it (403), placeimg.com (no response, shut 2023), placekitten.com (521), lorempixel.com (429), fillmurray.com and placecage.com (404), avatars.dicebear.com old API (410), loremflickr.com (401), fakeimg.pl (403). Alive: via.placeholder.com (dead in March 2026 reports, serving again in October), placehold.co, picsum.photos, dummyimage.com, api.dicebear.com, pravatar, randomuser.me, ui-avatars. GitHub code search hits: via.placeholder.com about 1.31M, source.unsplash.com about 219k, placehold.it about 209k.
  - [Reddit]: 14 strict-match posts (about 80% on topic). [v0forum]: 12 topic titles (images missing after deployment, wrong image path, missing from a zip). [LovCommits]: 2,116 'fix "broken image"'. Angular CLI issue 32908 (March 2026): its AI tutor, run in Claude Code, generated via.placeholder.com references. Scale AI reported replacing invented image URLs on a prompt-to-app platform.
  - [OwlEyes] (mobile crowdtesting, not AI): missing image is 25% of display issues.
- **Detection (cost: events):** img error events (capture phase on document) and, after load, img.complete && img.naturalWidth === 0, using currentSrc for srcset. For CSS backgrounds, PerformanceResourceTiming entries with responseStatus >= 400 where exposed (Chromium). Report the host and path. Use the dead-host list only as a severity hint: hosts come back, so the load result is the verdict.
- **False-positive traps:** loading=lazy images not yet requested (judge only when complete, or after scrolling into view); SVGs without intrinsic size report naturalWidth 0 in some engines; 1x1 tracking pixels; ad blockers and consent blockers; CSP blocks in test environments (separate kind); hidden carousel slides still fire error events; transient 429s.
- **Fault injection:** Route one visible content image to a 404 (or set src to https://images.unsplash.com/photo-1500000000000-000000000000?w=800, verified 404 on 2026-10-13); set another to https://source.unsplash.com/random/800x600 (503); remove srcset so currentSrc follows. For CSS, set a section background-image to a missing same-origin path.
- **Fix:** Self-host assets or use URLs returned by the provider's API; put static files in public/ and reference them with a leading slash or import them; give images a sized box and an onerror fallback; grep for dead hosts in CI.
- **Sources:** <https://unsplash.com/documentation/changelog>; <https://github.com/angular/angular-cli/issues/32908>; <https://hyper.ai/en/stories/3356555a4a52e04eb80807e1d839fef9>; <https://github.com/CopilotKit/CopilotKit/issues/3109>; <https://paul.af/rip-unsplash-source>; <https://community.vercel.com/t/missing-images-after-deployment/25918>; <https://community.vercel.com/t/wrong-image-path/7285>; <https://discuss.ai.google.dev/t/uploaded-logo-image-doesn-t-display/122232>; <https://www.reddit.com/r/boltnewbuilders/comments/1juihhx/>; <https://www.rapidevelopers.com/md/lovable-issues/fixing-broken-asset-paths-after-lovable-deployment>; <https://arxiv.org/abs/2009.01417>; <https://teamtreehouse.com/community/fyi-placeimg-has-been-shut-down>

<a name="12-image-distorted"></a>

### 12. Stretched, squashed or inconsistently cropped images

`image-distorted` | tier A | VISUAL.md: v1 `image-distorted` | injectors: `image-stretch`, `control-object-cover`

- **Renders:** Photos, logos and avatars forced into a box of another aspect ratio look stretched or squashed; thumbnails in one grid have different heights and crops.
- **Why AI-generated code does it:** w-full h-48 (or w-12 h-12) on an img without object-cover; images as direct flex children under the default align-items stretch; placeholder images hide the distortion at generation time.
- **How common:**
  - [XCompat]: image size distortion in 10.8% of failing pairs; hard-coded image size (w-full with fixed heights) is the root cause on 10.1% of failing AI pages.
  - [Corpus]: 185 of 1,934 img tags (10%) in 54 of 375 repos (14%) have both w-\* and h-\* classes and no object-\* class. [LovCommits]: 1,989 'fix stretched', 5,574 'fix aspect'.
  - Stack Overflow 37609642 (flexbox stretches my image) about 183k views; 34247337 (object-fit not affecting images) about 245k.
- **Detection (cost: pass):** For loaded raster images (naturalWidth > 0) with computed object-fit fill: |rendered aspect / natural aspect - 1| > 0.05. For grids, report sibling thumbnails whose rendered heights differ when the design is uniform (report-only).
- **False-positive traps:** object-fit cover and contain crops are intended; SVGs with preserveAspectRatio none; sprites; lazy placeholders whose natural size is the placeholder's; tiny icons; art direction with picture.
- **Fault injection:** Set width:100%;height:200px;object-fit:fill on a portrait photo, or width:200px;height:50px on a square logo.
- **Fix:** object-fit cover or contain with an aspect-ratio box; align-self start for images in flex rows; correctly sized sources.
- **Sources:** <https://arxiv.org/html/2608.12518v1>; <https://stackoverflow.com/questions/37609642>; <https://stackoverflow.com/questions/34247337>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+stretched&type=commits>; <https://www.reddit.com/r/lovable/comments/1kj5iqt/>

<a name="48-svg-icon-sizing"></a>

### 48. Icons at the wrong size (no viewBox, no width and height, squeezed in flex rows)

`svg-icon-sizing` | tier B | VISUAL.md: not covered | injectors: `svg-viewbox-removed`, `svg-unsized`, `icon-shrink`

- **Renders:** An icon resized by CSS but missing viewBox keeps drawing at its attribute size (a probe circle stayed 24px inside a 48px box) and looks small, offset or clipped; an icon with no width or height expands to its container width or 300x150, so a 24px icon becomes a page-wide graphic; icons and avatars in a flex row with long text shrink below their size.
- **Why AI-generated code does it:** Hand-written or simplified SVG markup drops viewBox or size classes; icon and avatar rows rarely get shrink-0.
- **How common:** [Corpus]: 129 of 1,708 inline SVGs (7.6%) in 37 of 375 repos (10%) lack viewBox. [LovCommits]: 146 'fix squished' (squished logo, squished avatars). Stack Overflow 19484707 (SVG scale with parent) about 637k views.
- **Detection (cost: pass):** svg without viewBox whose rendered rect differs from its width/height attributes by more than 1px, or whose getBBox() extends past the rect; svg with a viewBox of 48 units or less rendered over 96px and more than 4x the viewBox; svg or img inside a flex parent rendered under 0.8x its declared width.
- **False-positive traps:** SVGs rendered at their attribute size; symbol and use with their own viewBox; illustrations meant to scale; fluid icons at width 100%.
- **Fault injection:** Remove viewBox from icon SVGs whose CSS size differs from their attributes; or strip width, height and class from an icon svg inside a button; or remove shrink-0 from an icon beside long text in a narrow row.
- **Fix:** Always keep viewBox and size with CSS; explicit size classes (size-5); shrink-0 on icons and avatars.
- **Sources:** <https://stackoverflow.com/questions/19484707>; <https://bugzilla.gnome.org/show_bug.cgi?id=608102>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+squished&type=commits>

<a name="56-video-failed"></a>

### 56. Hero and background videos that never play

`video-failed` | tier B | VISUAL.md: partly `media-failed` (dead sources; autoplay blocked by policy is skipped there) | injectors: `video-autoplay-unmuted`, `video-no-playsinline-ios`, `video-source-404`, `video-source-dead-sample`, `control-video-muted-autoplay`, `control-video-controls`

- **Renders:** A full-bleed hero video shows a black or empty box, a frozen first frame or a play button instead of motion, and on an iPhone it may jump to fullscreen. With no poster image, text over the video sits on black or on nothing.
- **Why AI-generated code does it:** Chrome and Safari block autoplay without muted. iPhone Safari will not play inline without playsinline. React does not guarantee the muted attribute in server-rendered HTML (react #10389), so server-rendered pages can lose autoplay. Sources point at sample URLs from training data that are now dead (Google's gtv-videos-bucket sample files return 403) or at example.com/video.mp4.
- **How common:**
  - [Corpus] re-scan: 40 of 377 repos (11%) have a `<video>` element. Of the 26 with autoplay, 8 (31%) lack muted and 6 (23%) lack playsInline. Of 7 repos with remote video file URLs, 3 point at a dead source: example.com/video.mp4 placeholders in 2 (404), and Google's gtv-videos-bucket sample files in 1. BigBuckBunny, ElephantsDream and ForBiggerBlazes returned 403 on both commondatastorage.googleapis.com and storage.googleapis.com on 2026-10-13 (BigBuckBunny re-checked during the merge: 403).
  - GitHub code search: 25,568 files reference gtv-videos-bucket/sample. [LovCommits]: 3,139 'fix autoplay'. [SO] 43570460 (HTML5 video autoplay on iPhone): 288,931 views. react #10389 (muted not guaranteed by React): 94 reactions, open since 2017.
  - Tier B: a measured rate under 10% in AI output (8 of 377 repos ship autoplay without muted).
- **Detection (cost: events + pass):** Listen for video error events, and flag networkState === NETWORK\_NO\_SOURCE or readyState 0 five seconds after load in a visible tab. For a video with the autoplay attribute that is in the viewport, paused === true and currentTime === 0 after 3 s means autoplay failed. Static hints: autoplay without the muted attribute (read getAttribute, not the property) or without playsinline, and no poster. Report the src host when the load fails.
- **False-positive traps:** Hidden tabs and occluded windows, where autoplay pauses (the known GenClass hidden-tab artifact). Code that pauses on purpose under prefers-reduced-motion. iOS Low Power Mode and Data Saver, which block even muted autoplay. Videos with controls that the user is meant to start. Lazy videos not yet in view.
- **Fault injection:** On a page with a muted autoplay hero video: remove muted and reload the element (Chromium blocks the unmuted autoplay, as long as the harness keeps the default autoplay policy); remove playsinline under WebKit at an iPhone size; route the source to 404; or point it at the dead BigBuckBunny sample. Controls: a muted, playsinline autoplay video that plays, and a video with controls and no autoplay.
- **Fix:** Use autoPlay muted loop playsInline with a poster image and a CSS background colour, and self-host the file. For server-rendered pages, set the muted attribute explicitly (a ref callback, or render the video tag as HTML).
- **Sources:** <https://webkit.org/blog/6784/new-video-policies-for-ios/>; <https://developer.chrome.com/blog/autoplay>; <https://github.com/facebook/react/issues/10389>; <https://stackoverflow.com/questions/43570460>; <https://github.com/search?q=%22gtv-videos-bucket%2Fsample%22&type=code>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+autoplay&type=commits>

<a name="60-icon-missing"></a>

### 60. Icons that do not exist (hallucinated names, unloaded icon fonts)

`icon-missing` | tier B | VISUAL.md: v1 `icon-font-failed` (icon fonts); hallucinated component names not covered | injectors: `icon-ligature-typo`, `icon-font-link-removed`

- **Renders:** Importing a nonexistent lucide-react icon (Tool, StopIcon, a brand icon removed in lucide v1) throws at module link, so the page is blank in Vite dev and the build fails; dynamic Icons[name] lookups render nothing or crash; an invented Iconify name returns 404; a wrong Material Symbols ligature shows the raw word, and without display=block names show as text while the font loads; a wrong Font Awesome class renders an empty `<i>`; Figma Sites exports show icons as question marks.
- **Why AI-generated code does it:** Models mix icon vocabularies (feather Tool, heroicons StopIcon) and guess names; icon fonts referenced without their stylesheet.
- **How common:** [Corpus]: 4 of 375 repos (1%) import nonexistent lucide icons; 30 (8%) look icons up by name at runtime. Lucide v1 removed all brand icons; a v0 build log failed on a missing Instagram export; a v0 forum topic on lucide import build failures; Bolt's changelog lists auto-fixes for missing icons.
- **Detection (cost: pass):** Empty app root plus a SyntaxError in the console (see `page-blank`); svg.lucide with no child shapes; img to api.iconify.design with naturalWidth 0; .material-icons or .material-symbols elements whose font has no loaded FontFace or whose text is wider than one glyph box; i[class\*='fa-'] whose getComputedStyle(el, '::before').content is 'none' or empty.
- **False-positive traps:** Icons in hidden menus; icon fonts still loading (wait for document.fonts.ready); icons hidden on purpose; sprite icons fetched lazily.
- **Fault injection:** Change a Material Symbols ligature to shoping\_cart; change a Font Awesome class to fa-solid fa-nonexistent; point an Iconify img at logos/coinbase-icon.svg (404 in the corpus check); remove the icon font stylesheet link.
- **Fix:** Validate icon names against the installed package version, use static imports, pin icon library versions, import the icon CSS.
- **Sources:** <https://lucide.dev/guide/version-1>; <https://v0.app/aerostaticmarketing-1953s-projects/chat/tiago-mdok-website-eeZvy7FFlcW>; <https://community.vercel.com/t/build-fails-with-lucide-react-import-server-actions-errors/23997>; <https://developers.google.com/fonts/docs/material_symbols>; <https://www.reddit.com/r/boltnewbuilders/comments/1iypvid/>

<a name="62-embed-unavailable"></a>

### 62. Embedded videos and maps that show an error panel

`embed-unavailable` | tier B | VISUAL.md: partly (`image-broken` sees a failed static map image; `media-failed` skips cross-origin iframes) | injectors: `embed-youtube-dead-id`, `embed-maps-placeholder-key`, `control-embed-live-video`, `control-maps-query-embed`

- **Renders:** YouTube embeds show 'Video unavailable' or 'This video is private'. Google Maps shows a grey 'This page can't load Google Maps correctly' dialog or a darkened 'For development purposes only' map, and static map images appear broken.
- **Why AI-generated code does it:** Models invent YouTube ids, or remember ids that have since been deleted or made private. They paste Maps JavaScript or Static Maps URLs with key=YOUR\_API\_KEY, or with a key that has no billing. Builder previews often do not load third-party iframes, or the author never scrolls down to them.
- **How common:**
  - [Corpus] re-scan, every YouTube id checked through YouTube's oEmbed endpoint on 2026-10-13: 7 of 173 ids (4%) returned 404 (deleted or never existed) or 403 (private), in 4 of the 16 repos (25%) that use YouTube ids; one repo had 4 dead ids out of 15. Google Maps: 2 of 377 repos load Maps with key=YOUR\_API\_KEY (one Static Maps image, one Maps JavaScript script tag), and 9 embed google.com/maps/embed URLs.
  - [LovCommits]: 6,544 'fix "youtube"' and 6,177 'fix "google maps"', mixed with feature work. [Reddit]: a bolt user still gets 'This page can't load Google Maps correctly' after enabling the API.
  - Tier B on the catalog rule (a measured rate under 10% in AI output: 4 of 377 repos ship a dead id); the gap review proposed C.
- **Detection (cost: scan for YouTube; events and pass for Maps):** Cross-origin iframe content cannot be read from the page. Harness: collect YouTube ids from iframes and links and check each with `https://www.youtube.com/oembed?url=<watch url>&format=json` (200 alive, 401 embedding disabled, 403 private, 404 gone). In the page: on pages that use the YouTube IFrame API, listen for onError codes 100, 101 and 150. For Maps JavaScript, watch console errors and define window.gm\_authFailure. Scan script and img URLs for key=YOUR\_API\_KEY and similar placeholders.
- **False-positive traps:** Region-locked or age-restricted videos that work for the intended audience. Transient oEmbed rate limits (retry). Privacy extensions that block YouTube. EU cookie-consent walls inside the embed, which look like errors. Development keys on staging sites.
- **Fault injection:** Point a visible YouTube iframe at 0QeZhC7Y0-4 (oEmbed 404 on 2026-10-13; re-verify before each run), or insert an embed of it; or insert a 400x300 Static Maps image with key=YOUR\_API\_KEY (HTTP 403 on 2026-10-13) into the contact section. Controls: an embed of a live id, and a key-free maps iframe built from a place query (maps?q=...&output=embed).
- **Fix:** Use real video URLs from the owner and check them before launch. Use a restricted, billed Maps key, or a plain link or query-based iframe that needs no key.
- **Sources:** <https://oembed.com/>; <https://developers.google.com/youtube/iframe_api_reference#onError>; <https://developers.google.com/maps/documentation/javascript/error-messages>; <https://www.reddit.com/r/boltnewbuilders/comments/1p77eij/>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22google+maps%22&type=commits>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22youtube%22&type=commits>

<a name="86-chart-zero-size"></a>

### 86. Charts and maps rendered at zero size

`chart-zero-size` | tier C | VISUAL.md: not covered | injectors: `chart-parent-zero`

- **Renders:** The chart area or map is blank; pins do not show; a chart renders in one environment and not another, or intermittently after navigation; Recharts warns that width(-1) and height(-1) should be greater than 0.
- **Why AI-generated code does it:** Recharts ResponsiveContainer or Leaflet inside a parent with no definite height (auto-height cards, flex children, percentage heights, hidden tabs); dashboards are a top vibe-coded artefact.
- **How common:** shadcn-ui #8547 (19 reactions; reproduces in the dashboard-01 block about 1 load in 10). A v0 forum topic on charts not rendering in preview. XDA's v0 review hit chart overflow. A Base44 user's AI failed repeatedly on a 100vh map height. [LovCommits]: 30,354 'fix chart' (mixed).
- **Detection (cost: pass):** .recharts-responsive-container, .recharts-wrapper, svg.recharts-surface, canvas or .leaflet-container with clientWidth or clientHeight under 10px while visible, or a chart surface with no marks after load; capture the console warning.
- **False-positive traps:** Charts in inactive tabs measured before display; lazily mounted charts (wait).
- **Fault injection:** Set the chart container's parent style.height='0px', or .leaflet-container{height:0}.
- **Fix:** An explicit height or aspect ratio on the container (h-[300px], aspect-video), initialDimension.
- **Sources:** <https://github.com/shadcn-ui/ui/issues/8547>; <https://community.vercel.com/t/charts-do-not-render-in-the-preview-but-work-in-the-deployed-site/8072>; <https://www.xda-developers.com/tried-vibe-coding-a-real-app-in-bolt-v0-and-lovable/>; <https://fixdevs.com/blog/recharts-not-working/>

<a name="87-webgl-canvas-blank"></a>

### 87. 3D and WebGL heroes with no fallback when WebGL fails

`webgl-canvas-blank` | tier C | VISUAL.md: not covered (`page-blank` counts a canvas as content) | injectors: `webgl-context-null`, `webgl-context-lost`, `control-webgl-fallback-shown`

- **Renders:** Three.js, React Three Fiber, OGL or Spline heroes render as a blank or black rectangle, freeze, or crash the tab on low-end phones, in battery saver, with hardware acceleration off, or after the GPU drops the context. Text placed over the canvas then sits on nothing.
- **Why AI-generated code does it:** 3D globes, particle fields and shader backgrounds are a common AI landing-page flourish. Models add the scene without checking that WebGL is available, without handling webglcontextlost, without capping devicePixelRatio, and without a static image for small screens.
- **How common:** [Corpus] re-scan: 24 of 377 repos (6%) ship a WebGL library (three 23, @react-three/fiber 20, ogl 4, pixi.js 1), and 1 of the 24 handles context loss or missing WebGL. [LovCommits]: 853 'fix "three.js"', 707 'fix webgl', 646 'fix spline'. [SO] 25219352 (WebGL scene doesn't render because of lost context): 55,076 views. No measured failure rate.
- **Detection (cost: events + pass):** Listen for webglcontextlost on canvases (capture phase on document). For visible canvases covering 20% or more of the viewport, check gl.isContextLost(), a null getContext result, or (in the harness) a pixel sample that is uniform. Report when no non-canvas fallback sibling is visible. Report-only: canvases whose backing store exceeds about 4096 x 4096 (width x devicePixelRatio) on phones, as a crash risk.
- **False-positive traps:** Decorative canvases faded out on purpose. Scenes still loading within the budget (Spline loads a large runtime). Headless Chromium with software GL behaves differently from real devices. Games and editors where the canvas is the app.
- **Fault injection:** Make getContext return null for webgl, webgl2 and experimental-webgl before page scripts run, so the scene fails to initialise; or lose the context of the largest visible WebGL canvas with WEBGL\_lose\_context. Control: the same lost context with a visible image fallback over the canvas.
- **Fix:** Check WebGL support before mounting the scene, show a poster image on failure and on small or reduced-motion screens, handle webglcontextlost and webglcontextrestored, and cap the pixel ratio (React Three Fiber dpr={[1, 2]}).
- **Sources:** <https://stackoverflow.com/questions/25219352>; <https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextlost_event>; <https://threejs.org/docs/#manual/en/introduction/WebGL-compatibility-check>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+webgl&type=commits>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22three.js%22&type=commits>

<a name="100-image-blurry"></a>

### 100. Blurry upscaled images

`image-blurry` | tier C | VISUAL.md: not covered | injectors: `image-low-res`

- **Renders:** Low-resolution raster images rendered far above their natural size look blurred.
- **Why AI-generated code does it:** Thumbnails reused as heroes; images added by URL without srcset.
- **How common:** [OwlEyes]: blurred screen in 1% of mobile display issues. [LovCommits]: 448 'fix blurry'. A Base44 user with blurry images added by URL.
- **Detection (cost: pass):** Raster images over 64px where rendered width times devicePixelRatio > 2x naturalWidth.
- **False-positive traps:** filter blur backgrounds on purpose; LQIP placeholders before swap; pixel art with image-rendering pixelated.
- **Fault injection:** Swap one hero src to a version at a quarter of the resolution displayed at the same size.
- **Fix:** srcset and sizes; adequate source resolution.
- **Sources:** <https://arxiv.org/abs/2009.01417>; <https://www.reddit.com/r/Base44/comments/1ns1wzn/>

<a name="110-csp-blocked"></a>

### 110. Images, fonts and styles blocked by the site's own Content-Security-Policy

`csp-blocked` | tier D | VISUAL.md: v1 `csp-blocked` | injectors: `csp-meta-blocks-assets`, `control-csp-allows-hosts`

- **Renders:** Images, fonts, styles or media that the page references never load, because the site's own Content-Security-Policy does not list their host. The page looks partly broken (missing images, fallback fonts) with nothing wrong in the markup.
- **Why AI-generated code does it:** Security hardening prompts ('add security headers') produce a strict CSP that omits the hosts the site actually uses.
- **How common:** [Corpus] re-scan: 7 of 377 repos (2%) ship a CSP, as a meta tag or host headers, and by a regex check none of the 7 blocks an asset its own code uses. One Lovable CSP sets img-src 'self' data: blob:, which would block every remote image, but that repo loads none. [Reddit]: 2 relevant posts, a v0 preview with blocked speed-insights calls and a Lovable user whose Lovable-written CSP blocked Supabase requests (data, not visuals). [LovCommits]: 915 'fix "Content Security Policy"'. Tier D: no failure was found in the corpus. The entry exists so that the v1 kind has an injector; keep it as a cheap events check and do not spend training budget on it.
- **Detection (cost: events):** Listen for securitypolicyviolation from init (violations during load cannot be queried later), and map effectiveDirective (img-src, style-src, font-src, media-src) plus blockedURI to the affected elements (VISUAL.md 3.7).
- **False-positive traps:** Report-Only policies (the disposition is report). Violations from browser extensions (sourceFile chrome-extension). Analytics beacons blocked on purpose.
- **Fault injection:** At the top of head, add a CSP meta with img-src 'self' and font-src 'self' on a page with remote images and Google Fonts. Control: a CSP that allows every image and font host.
- **Fix:** Build the CSP from the hosts the site actually loads, and test it with Content-Security-Policy-Report-Only first.
- **Sources:** <https://www.reddit.com/r/v0_/comments/1t6fkd1/>; <https://www.reddit.com/r/lovable/comments/1k4e1bc/>; <https://developer.mozilla.org/en-US/docs/Web/API/SecurityPolicyViolationEvent>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22Content+Security+Policy%22&type=commits>

## Missing styles or fonts

CSS that the page references but never gets: unbacked utility classes, invalid tokens, missing plugins, fonts that never load, whole stylesheets that fail.

<a name="29-css-token-invalid"></a>

### 29. Theme tokens that resolve to nothing or to an invalid colour (transparent surfaces)

`css-token-invalid` | tier B | VISUAL.md: v1 `css-var-undefined` (undefined variables only; not invalid values) | injectors: `token-undefined`, `token-double-wrap`, `token-popover-transparent`, `control-ghost-transparent`

- **Renders:** Buttons lose their fill, cards lose their surface, borders and rings vanish, and dropdowns, popovers, selects, tooltips, Sonner toasts, calendars and mobile sidebar sheets render transparent so their text sits over the page text. A probe in Chrome gave computed background rgba(0, 0, 0, 0) and inherited colour.
- **Why AI-generated code does it:** background-color: hsl(var(--primary)) with --primary undefined, or holding a full colour (hsl(oklch(...))), or bare HSL channels in v4, is invalid at computed-value time and falls back to transparent or inherited. shadcn moved from HSL channels to full OKLCH values with Tailwind v4; models mix old components and snippets with the new theme, drop the :root token block when rewriting index.css, or add tokens to the config without defining them in CSS.
- **How common:**
  - [Corpus]: 20 of 108 v0 repos (19%), 3 of 110 bolt and 1 of 157 Lovable reference hsl(var(--x)) where every definition of --x is a full colour (mostly sidebar-border and sidebar-accent). 5 of 157 Lovable repos use tokens that are never defined; 35 of 157 ship shadcn sidebar.tsx referencing --sidebar-\* tokens never defined (latent until the Sidebar renders).
  - shadcn issues: calendar background transparent (#2261, 14 comments), tooltip transparent (#2720), Sonner transparent (#8748), sidebar transparent on mobile (#6002, 11 comments); discussion #2996 on the v4 upgrade. A Base44 post on tokens not applying.
- **Detection (cost: pass):** Walk readable CSSOM declarations whose value contains var(--x) without a fallback; for elements matched by those rules, getComputedStyle(el).getPropertyValue('--x') === '' means undefined. For colour properties, resolve --x and flag values that start with a colour function, '#' or a named colour inside hsl()/rgb() wrappers. Symptom check: visible floating layers ([data-radix-popper-content-wrapper] children, role menu/listbox/tooltip/dialog, [data-sonner-toast]) whose composited background alpha is 0 with no backdrop-filter while elementsFromPoint shows text underneath; and elements carrying token classes (bg-primary, bg-card) that compute transparent.
- **False-positive traps:** Variables defined on a nearer ancestor (resolve on the element); variables set later by JS theme loaders (wait for settle); ghost buttons and glass layers that are transparent on purpose; cross-origin sheets throw on cssRules (unknown, not missing).
- **Fault injection:** Inject :root{--popover:initial} (guaranteed-invalid, same as undefined) on a shadcn page and open a menu; or :root{--primary: oklch(0.6 0.2 250)} where buttons use hsl(var(--primary)); or set style="background-color:hsl(var(--gc-undefined))" on a primary button.
- **Fix:** Define every token used by the theme mapping in both :root and .dark; in v4 reference var(--x) directly and never wrap oklch in hsl(); use var(--x, fallback); lint the config against the CSS variables.
- **Sources:** <https://developer.mozilla.org/en-US/docs/Web/CSS/Using_CSS_custom_properties>; <https://ui.shadcn.com/docs/tailwind-v4>; <https://github.com/shadcn-ui/ui/issues/2261>; <https://github.com/shadcn-ui/ui/issues/2720>; <https://github.com/shadcn-ui/ui/issues/8748>; <https://github.com/shadcn-ui/ui/issues/6002>; <https://github.com/shadcn-ui/ui/discussions/2996>; <https://www.reddit.com/r/Base44/comments/1qe9087/>; <https://defensivecss.dev/tips/>

<a name="32-font-not-loaded"></a>

### 32. Declared web font never loads or never applies

`font-not-loaded` | tier B | VISUAL.md: v1 `font-failed` (failed loads); fonts never requested are not covered | injectors: `font-link-removed`, `font-gfonts-400`, `font-file-404`

- **Renders:** Text renders in a fallback with different weight, tracking and metrics (wrapping and overflowing buttons, faux bold), while the author sees the design because the font is installed locally. A whole Google Fonts request that returns 400 drops every family in it. Typography changes between preview and production.
- **Why AI-generated code does it:** font-family 'Inter' (or Poppins, Fira Code) declared in the Tailwind config or CSS without the link, @import, @font-face or next/font import; Google Fonts URLs naming families that are not on Google Fonts (SF Pro Display, Söhne), invented names, wght@0,500 without ital, or variable ranges on static families (Poppins wght@100..900 returns 400); create-next-app's globals.css keeps body font-family Arial while Geist is exposed only as a variable.
- **How common:**
  - [Corpus]: 45 of 375 repos (12%) declare a non-system family with no matching load (Inter 25, Poppins 6, Fira Code 5; many Inter hits are the Vite template's stack, a designed fallback). 4 of 144 Google Fonts URLs (2.8%) returned 400. A Söhne plus Inter URL returned 400 while Inter alone returned 200.
  - [LovCommits]: 23,110 'fix font' (mixed). Agency guides for Lovable font issues; a v0 forum topic on typography with Tailwind 4 and Next 16. A practitioner list of bugs AI generators ship: Inter 500 with tracking specified, system font at 400 rendered.
- **Detection (cost: events):** link[rel=stylesheet][href\*='fonts.googleapis.com'] with link.sheet === null or an error event; FontFace entries with status error. For fonts never requested: for the first family in the computed font-family of visible text, look for a FontFace in document.fonts with that family and status loaded. Do not rely on document.fonts.check(): a probe returned true for '16px Inter' with no Inter loaded, because check() is vacuously true when no FontFace matches. Or measure a test string in `'<family>, monospace'` against 'monospace' (equal widths mean unavailable). Also flag a body computed font-family starting with Arial while a next/font variable class is on html or body.
- **False-positive traps:** Local installs make this machine-dependent (test with local fonts disabled); intentional fallback stacks and system-ui by design; fonts loaded by cross-origin CSS you cannot read; privacy extensions and CSP blocking the sheet (report as font CSS failed, not invalid family); fonts gated by consent; fonts still loading (wait for document.fonts.ready).
- **Fault injection:** Remove the font link or @font-face while keeping font-family; append &family=Sohne:wght@400 to a working css2 URL (400 for the whole URL); or route the font file to 404.
- **Fix:** Load every declared family (self-host via @fontsource or next/font) or remove it from the stack; one validated css2 URL per family set; map --font-sans in @theme inline or use var(--font-geist-sans) on body.
- **Sources:** <https://developers.google.com/fonts/docs/css2>; <https://fixdevs.com/blog/nextjs-font-not-loading/>; <https://community.vercel.com/t/v0-tailwind-4-next-16-the-perfect-storm-for-typography/25907>; <https://dev.to/oqa/vibe-coding-problems-7-visual-bugs-ai-code-generators-always-ship-37mf>; <https://overlayqa.com/blog/ai-app-builders-visual-bugs/>; <https://www.rapidevelopers.com/lovable-issues>

<a name="38-tailwind-class-missing"></a>

### 38. Utility classes that generate no CSS (interpolated names, scan paths, invented shades)

`tailwind-class-missing` | tier B | VISUAL.md: held back (VISUAL.md section 4: utility class missing in production) | injectors: `class-unbacked-token`, `class-subtree-unbacked`

- **Renders:** Status badges, progress bars, colour-coded cards and hover states look right for some values and have no colour, width or effect for others, often only in production. Whole components render with browser defaults when their files sit outside the scan paths.
- **Why AI-generated code does it:** Tailwind scans source as plain text and cannot see bg-${color}-500, w-[${pct}%] or 'text-' + size; models generalize data-driven components into template literals. Folders moved outside v3 content globs, or gitignored and node\_modules UI packages skipped by v4 auto-detection. Interpolated shades that exist in no Tailwind version (bg-slate-750, hover:bg-gray-1000, bg-blue-25). text-md compiles in neither v3 nor v4.
- **How common:**
  - [Corpus]: interpolated colour or width classes (strict pattern) in 22 of 375 repos (6%): Lovable 9, v0 6, bolt 7. Invalid palette shades in 6 of 375 (2%).
  - Stack Overflow 69687530 (dynamic Tailwind classes) about 156k views. 126 tailwindcss discussions have dynamic in the title; 25 are titled not generated (#17905 monorepo, #16213 production). daisyUI's maintainer calls it the most common Tailwind mistake. [Reddit]: 1 post; Lovable troubleshooting guides cover it.
- **Detection (cost: pass):** Build a set of class names from every readable same-origin CSSOM selector (recurse into @media, @layer, @supports, @container; undo CSS escapes in selector text; parse v4 :where() selectors as tokens). For class tokens on rendered elements matching utility grammar (known prefixes, variant prefixes, [arbitrary] values), flag those absent from the set; strengthen with an effect check (bg-\* token but transparent background, w-[..] but width auto). Cluster by subtree: most tokens unbacked in one component while the rest of the page is styled means scan paths.
- **False-positive traps:** Classes used only as JS or test hooks; marker classes with no rules (group, peer, dark, not-prose); state classes added later; the Tailwind Play CDN and CSS-in-JS that generate rules after mutations (re-scan); cross-origin sheets (unknown, not missing); shadow DOM styles; other frameworks with similar tokens; tailwind.config extensions that make a shade valid (check generated CSS, not a static list).
- **Fault injection:** Replace a badge's bg-green-500 with bg-green-550 (or bg-gc-unknown-500) so no rule matches; or rename every class in one component subtree with a prefix.
- **Fix:** Map values to complete class strings, use @source inline() or safelist, or inline style and CSS variables for continuous values; update content globs or add @source for UI packages.
- **Sources:** <https://tailwindcss.com/docs/detecting-classes-in-source-files>; <https://stackoverflow.com/questions/69687530>; <https://daisyui.com/blog/most-common-mistake-when-using-tailwind-css/>; <https://github.com/tailwindlabs/tailwindcss/discussions/18137>; <https://github.com/tailwindlabs/tailwindcss/discussions/17905>; <https://github.com/tailwindlabs/tailwindcss/discussions/16213>; <https://www.rapidevelopers.com/md/lovable-issues/ensuring-tailwindcss-classes-apply-properly-in-lovable>; <https://flaviocopes.com/tailwindcss-cannot-generate-classes-dynamically.md>

<a name="39-tailwind-version-mix"></a>

### 39. Tailwind v3 and v4 vocabulary mixed (classes and config the installed version ignores)

`tailwind-version-mix` | tier B | VISUAL.md: held back (same detector as `tailwind-class-missing`) | injectors: `tw-v4-name-in-v3`, `tw-opacity-backdrop-opaque`, `tw-config-tokens-missing`

- **Renders:** In a v3 project, v4-only names generate nothing: a z-60 modal sits under a z-50 header, bg-linear-to-r heroes lose their gradient (and gradient text turns invisible), shadow-xs, rounded-xs, outline-hidden, bg-(--brand), gap-4.5 do nothing. In a v4 project, bg-opacity-\*, text-opacity-\* and border-opacity-\* generate nothing, so a bg-black bg-opacity-50 backdrop renders solid black and hides the page; bg-[--brand] compiles to an invalid declaration; a v3 tailwind.config.js is never loaded, so bg-primary, font-display and animate-\* custom tokens are missing.
- **Why AI-generated code does it:** Models mix v3 and v4 knowledge; most Tailwind code in training data is v3 while v0 and create-next-app projects are v4 and Lovable projects are almost all v3. Other libraries show the same mix of major versions (`calendar-version-mismatch`, `bootstrap-version-mix`).
- **How common:**
  - [Corpus]: v4-only class names in 17 of 328 v3 repos (5%); opacity utilities in 6 of 42 v4 repos (14%); a tailwind.config.\* with no @config in 5 of 42 v4 repos (12%). [LovCSS]: only 506 of 79,360 lovable-tagger package.json files use @tailwindcss/vite. v4 is used by 33 of 108 corpus v0 repos (31%).
  - Local compile checks with Tailwind 4.3.3, 4.1.14 and 3.4.19 confirm each listed class. flex-shrink-0, flex-grow, overflow-ellipsis, decoration-clone and bg-gradient-to-r still compile in v4 despite the upgrade guide, so they are not bugs.
  - 16 tailwindcss discussions with bg-opacity in the title (#18193, #17571); fix PRs replacing bg-opacity backdrops; discussion #16517 (19 upvotes: config not rendering, broken dark mode; a maintainer calls a ChatGPT-generated globals.css wrong for v4); #15132. Vercel threads on Tailwind 3 dependencies overridden with v4 on deploy.
- **Detection (cost: pass):** The unbacked-class detector from `tailwind-class-missing`, plus a version fingerprint from the CSSOM (v4: @layer theme/base/components/utilities, @property --tw-\*, --color-\* tokens; v3: --tw-ring-offset-shadow on universal rules). Report version-specific misses with the matching name (z-[60] in v3, bg-black/50 in v4). For backdrops: a fixed layer over 90% of the viewport with opaque background while a dialog is open and an \*-opacity-\* token with no rule. For configs: systematic absence of every custom token class.
- **False-positive traps:** Projects that define compat utilities; config extensions that make z-60 valid in v3 (check generated CSS); intentionally opaque full-screen menus; config files left over but migrated to @theme.
- **Fault injection:** In a v3 build change a modal's z-[60] to z-60 or bg-gradient-to-r to bg-linear-to-r; in a v4 build change bg-black/50 on a dialog backdrop to bg-black bg-opacity-50 (opaque black); or remove the @theme block that defines --color-primary.
- **Fix:** Pin one Tailwind major version with matching setup; arbitrary values in v3 (z-[60]); slash opacity and bg-(--brand) in v4; @config or @theme for custom tokens; run npx @tailwindcss/upgrade; lint against the installed version.
- **Sources:** <https://tailwindcss.com/docs/upgrade-guide>; <https://eval.16x.engineer/blog/tailwind-css-v3-z-index-eval>; <https://github.com/tailwindlabs/tailwindcss/discussions/18193>; <https://github.com/tailwindlabs/tailwindcss/discussions/16517>; <https://github.com/tailwindlabs/tailwindcss/discussions/15132>; <https://github.com/theopenlane/openlane-ui/pull/1536>; <https://github.com/alcotttheunicorn/alcott-web-/pull/17>; <https://community.vercel.com/t/v0-deploy-challenge-libraries-tailwind-v3-v4/24250>

<a name="46-tailwind-plugin-missing"></a>

### 46. Plugin classes used without the plugin (prose, animate-in)

`tailwind-plugin-missing` | tier B | VISUAL.md: not covered | injectors: `prose-rules-removed`, `keyframes-removed`

- **Renders:** Terms, privacy, blog and rendered-markdown pages show headings at body size, lists without bullets (Preflight removes them) and no paragraph spacing; Accordion, Dialog and Sheet snap open or stutter because animate-in, fade-in and accordion-down have no keyframes.
- **Why AI-generated code does it:** The model writes prose prose-lg and animate-in fade-in from memory without adding @tailwindcss/typography or tailwindcss-animate (tw-animate-css in v4); v3 plugin setup copied into v4.
- **How common:**
  - [Corpus]: prose without @tailwindcss/typography in 30 of 375 repos (8%; v0 13%, bolt 13%); animate-in without a plugin in 9 (2%). 79,104 of 79,360 lovable-tagger package.json files list tailwindcss-animate.
  - shadcn #6925 (missing animation variables in v4) 36 reactions; #6440 (Sheet stutter after v3 to v4) 12 reactions. Tailwind Preflight docs note that unstyled lists are not announced as lists by VoiceOver.
- **Detection (cost: pass):** Element with class prose and no CSSOM rule for .prose, or an h2 inside it whose font-size equals its parent's; ul/ol with list-style none holding text items and no role=list. Elements carrying animate-\* (or data-[state=open]:animate-in) whose computed animation-name is none in that state, or animation names with no matching @keyframes.
- **False-positive traps:** Apps defining their own .prose; nav lists unstyled on purpose; prefers-reduced-motion; low severity for the animation case.
- **Fault injection:** Remove all .prose rules from the stylesheet on a docs page; or delete the @keyframes accordion-down rule.
- **Fix:** Install and register the plugin (@plugin in v4, @import "tw-animate-css"), or style the content directly.
- **Sources:** <https://tailwindcss.com/docs/preflight>; <https://ui.shadcn.com/docs/tailwind-v4>; <https://github.com/shadcn-ui/ui/issues/6925>; <https://github.com/shadcn-ui/ui/issues/6440>

<a name="70-stylesheet-not-applied"></a>

### 70. Whole page renders with browser defaults (stylesheet missing or Tailwind setup broken)

`stylesheet-not-applied` | tier C | VISUAL.md: v1 `stylesheet-failed` (failed loads); setup errors that produce no rules are not covered | injectors: `stylesheets-disabled`, `stylesheet-404`

- **Renders:** Times font, 8px body margin, blue underlined links and stacked divs although the markup is full of utility classes; or one page loses all styling after a regeneration; preview intact, production unstyled.
- **Why AI-generated code does it:** Tailwind v3 directives (@tailwind base) used with v4, a missing @tailwindcss/postcss or vite plugin, an @apply error that fails the stylesheet, @apply in CSS modules without @reference, a generated CSS import dropped during a rewrite, or a stylesheet that 404s after build. The failure is silent.
- **How common:** [Reddit]: 7 strict plus about 6 verified (Cursor gave v3 setup steps but installed v4; a dashboard that looks like 2003 HTML). [v0forum]: 10 topic titles on Tailwind v3/v4 deploy failures. tailwindcss #15778 (cannot apply unknown utility class) 58 reactions, 76 comments; discussion #16429 (@apply broken in v4) 110 upvotes, 91 comments. Drupal Canvas: an AI agent's @apply left a component unstyled.
- **Detection (cost: pass):** link[rel=stylesheet] with sheet === null or an error event (VISUAL.md `stylesheet-failed`). Setup failures: more than 50 utility-looking tokens on the page with under 5% backed by a rule, or Preflight absent (body margin 8px, h1 at 2em, buttons with the UA ButtonFace background), or an element with class flex computing display block.
- **False-positive traps:** Sites not using Tailwind; deliberately unstyled documents; print-only sheets; first paint before CSS loads.
- **Fault injection:** Disable every stylesheet (for (const s of document.styleSheets) s.disabled = true), or route the main CSS file to 404.
- **Fix:** Match the setup to the installed version (@import "tailwindcss" with @tailwindcss/vite or /postcss in v4), @reference in files using @apply, verify the production build.
- **Sources:** <https://github.com/tailwindlabs/tailwindcss/issues/15778>; <https://github.com/tailwindlabs/tailwindcss/discussions/16429>; <https://github.com/tailwindlabs/tailwindcss/discussions/19466>; <https://www.reddit.com/r/cursor/comments/1k76wl3/>; <https://community.vercel.com/t/how-to-fix-deployment-issues-with-tailwind-v3/24020>; <https://community.vercel.com/t/investigating-v0-preview-doesnt-match-vercel-deployment/12440/3>; <https://git.drupalcode.org/project/canvas/-/work_items/3544277>

<a name="78-css-order-dev-prod"></a>

### 78. CSS cascade order differs between dev and production

`css-order-dev-prod` | tier C | VISUAL.md: not covered | injectors: `stylesheet-order-swap`

- **Renders:** Equal-specificity rules from layout CSS, CSS modules and library CSS land in a different chunk order in production, so padding, colours or icon sizes flip between dev and prod or between navigations.
- **Why AI-generated code does it:** Generated overrides rely on source order instead of specificity or layers.
- **How common:** vercel/next.js #64921 (78 reactions, 109 comments, open), #51030 (75 reactions, 124 comments), #16630 (140 reactions); vitejs/vite #3924 (107 reactions, 82 comments, open), #21903 (45 reactions; Vite 8 and Rolldown regression, still reported in September 2026).
- **Detection (cost: pass):** For sampled elements, find properties set by two or more equal-specificity rules from different stylesheets with different values (unlayered, or in the same layer) and report them as order-dependent; a dev against prod screenshot diff in CI catches the realized case.
- **False-positive traps:** Conflicts with identical values; rules in different @layers are order-independent; theme overrides loaded last by design.
- **Fault injection:** Swap the order of two `<link rel=stylesheet>` elements in head.
- **Fix:** Declare @layer order, intentional specificity, Next cssChunking 'strict'.
- **Sources:** <https://github.com/vercel/next.js/issues/64921>; <https://github.com/vercel/next.js/issues/51030>; <https://github.com/vitejs/vite/issues/3924>; <https://github.com/vitejs/vite/issues/21903>

<a name="79-tailwind-v4-defaults"></a>

### 79. Tailwind v4 default changes rendered against v3 habits (cursor, borders, rings, container, scales)

`tailwind-v4-defaults` | tier C | VISUAL.md: not covered | injectors: `tw4-cursor-default`, `tw4-border-currentcolor`, `tw4-container-uncentered`

- **Renders:** Buttons show the arrow cursor (v4 Preflight sets cursor default) and read as static; a bare border is now currentColor, so cards and inputs get heavy dark borders; ring is 1px currentColor instead of 3px blue-500, so focus rings get thin and dark; .container no longer centres or pads, so content hugs the left edge and touches phone edges; shadow-sm, rounded and blur-sm render one step smaller; space-y now sets margin-bottom on non-last children and has no effect on inline children.
- **Why AI-generated code does it:** v3 idioms and default expectations in v4 installs; generated v4 plus shadcn code omits a cursor rule.
- **How common:** shadcn-ui #6843 (buttons cursor default in v4) 130 reactions, 52 comments, open; the top workaround comment has 227 upvotes; shadcn added an opt-in init --pointer flag in May 2026. tailwindcss discussions #15203, #18182, #19454 (cursor), #14508 (border), #15429 (container), #17019 and #16329 (space-y). 28 PRs titled with cursor-pointer and v4. Compile checks confirm .ring as 1px currentcolor and .container with no margin.
- **Detection (cost: pass):** In v4 builds (CSSOM has @layer theme and --color-\*): enabled button and [role=button] with computed cursor default (low severity); bordered card-like boxes whose border-color equals the text colour and is dark (luminance under 0.1) on a light UI; .container elements with zero inline margin while the parent is 40px or more wider; a space-y-\* container with display inline children.
- **False-positive traps:** Deliberate native-app cursor convention; intentional currentColor borders (neo-brutalist styles); shadcn's base layer sets border-color var(--border); projects that restore v3 defaults in @layer base.
- **Fault injection:** Inject button{cursor:default!important}; \*{border-color:currentColor} on a page of light cards; .container{margin-inline:0!important;padding-inline:0!important}.
- **Fix:** button:not(:disabled),[role=button]:not(:disabled){cursor:pointer} in @layer base; explicit border colours or the upgrade guide's compatibility rule; @utility container {margin-inline:auto; padding-inline:2rem}; rename scales per the upgrade guide.
- **Sources:** <https://github.com/shadcn-ui/ui/issues/6843>; <https://tailwindcss.com/docs/upgrade-guide>; <https://github.com/tailwindlabs/tailwindcss/discussions/15203>; <https://github.com/tailwindlabs/tailwindcss/discussions/14508>; <https://github.com/tailwindlabs/tailwindcss/discussions/15429>; <https://github.com/tailwindlabs/tailwindcss/discussions/17019>; <https://www.v2ex.com/t/1211082>

<a name="90-calendar-version-mismatch"></a>

### 90. Component code written for an older major version of its library (shadcn Calendar v8 API on react-day-picker v9)

`calendar-version-mismatch` | tier C | VISUAL.md: not covered | injectors: `calendar-v8-classnames-on-v9`, `control-calendar-open`

- **Renders:** The date picker opens as an unstyled grid: weekday headers and days fall out of their seven columns, the navigation arrows sit in the wrong place, and the selected day has no highlight. The installed version ignores the classNames keys and the IconLeft and IconRight components that the file passes.
- **Why AI-generated code does it:** The model installs the latest react-day-picker (v9; v10 has since shipped as @daypicker/react) but writes or keeps the shadcn calendar.tsx written for v8. shadcn moved its Calendar to v9 in June 2025, so training data holds both APIs. Vite does not type-check, and v0 projects often set typescript.ignoreBuildErrors, so the mismatch builds.
- **How common:** [Corpus] re-scan: 247 repos have react-day-picker and a calendar.tsx. 9 of them (4%; bolt 5, v0 3, Lovable 1) pair a v9 dependency with the v8 API (`nav_button`, `day_selected`, IconLeft), and 3 of the 9 are v0 projects with ignoreBuildErrors. Only 1 of the 9 renders the Calendar on a page, so most are latent. shadcn #910 has a thread where the date range picker's styling broke after react-day-picker 9.0.0. No measured rate of visible failures. Other major-version renames follow the same pattern; lucide renames are in `icon-missing`, and Tailwind's in `tailwind-version-mix`.
- **Detection (cost: pass, run on interaction):** When a [role=grid] calendar is visible (react-day-picker renders .rdp or .rdp-root), take the first full week row and check that it holds 7 cells at distinct, increasing x positions with similar widths (within 30%). Report when there are fewer than 7 distinct columns, when cell width differs from header width by more than 50%, or when the selected day (aria-selected=true) has the same computed background as the other days.
- **False-positive traps:** Custom calendars with week numbers (8 columns) or list views. Calendars mid open-animation. Month views partly hidden by design. Narrow popovers that wrap on purpose.
- **Fault injection:** Open a calendar, remove every class on its descendants except those that start with rdp, and delete react-day-picker's own rules if its stylesheet is loaded (this simulates v8 classNames that v9 ignores). Control: the same calendar opened untouched.
- **Fix:** Run npx shadcn@latest add calendar --overwrite to get the v9 API, or pin react-day-picker to the major version the component was written for.
- **Sources:** <https://ui.shadcn.com/docs/changelog/2025-06-calendar>; <https://github.com/shadcn-ui/ui/issues/910>; <https://daypicker.dev/upgrading>; <https://www.skills.sh/openaec-foundation/shadcn-ui-claude-skill-package/shadcn-errors-react-day-picker-v9>

<a name="91-bootstrap-version-mix"></a>

### 91. Bootstrap 4 markup on Bootstrap 5 pages (dead navbar toggler, ignored spacing classes)

`bootstrap-version-mix` | tier C | VISUAL.md: not covered | injectors: `bootstrap4-attrs-on-5`, `control-bootstrap-both-attrs`

- **Renders:** On phones the hamburger button does nothing, and dropdowns and modals do not open. Utilities such as ml-auto, mr-3, float-left and text-left have no effect, so items crowd to the left. Desktop looks fine because the collapsed nav is already expanded there.
- **Why AI-generated code does it:** Plain HTML pages written with ChatGPT, Claude or Cursor (outside the Tailwind builders) load the Bootstrap 5 CDN but use Bootstrap 4 attributes and classes (data-toggle, data-target, ml-\*, mr-\*, badge-pill, form-group), which dominate older training data.
- **How common:** Not measurable in the builder corpus: 1 of 377 repos uses Bootstrap. GitHub code search on 2026-10-13: 48,384 HTML files load bootstrap@5 and contain data-toggle="collapse" (the v4 attribute), against 2,351,104 that use data-bs-toggle="collapse", so about 2% of Bootstrap 5 pages with a collapse use the old attribute. [SO] 65341620 (Navbar dropdown (collapse) is not working in Bootstrap 5): 76,880 views. No AI-specific rate.
- **Detection (cost: pass):** Read the Bootstrap major version from window.bootstrap?.Tooltip?.VERSION or from the CDN URL. With 5.x loaded, report elements that have data-toggle or data-target but no data-bs-\* equivalent, and elements using v4-only utilities (ml-\*, mr-\*, pl-\*, pr-\*, float-left, text-left, badge-pill, custom-select) for which no CSSOM rule exists. Harness: at 375 px, click .navbar-toggler and check that .navbar-collapse becomes visible.
- **False-positive traps:** Sites that load Bootstrap 4 on purpose. Custom CSS that defines ml-\* itself. Other libraries that use data-toggle (Bootstrap Table, older plugins). Tailwind sites using ml-\* (Tailwind defines those classes, so check the CSSOM, not the class name).
- **Fault injection:** At 375x740 on a Bootstrap 5 page, rename data-bs-toggle and data-bs-target on the navbar toggler to data-toggle and data-target, and replace ms-auto with ml-auto on the nav list. Control: a toggler that carries both the v4 and the v5 attributes, which still works. The gap review proposed a Bootstrap 4.6 page as the control; Bootstrap 4's JavaScript needs jQuery, so swapping the CDN URL alone would break the page.
- **Fix:** Use Bootstrap 5's data-bs-\* attributes and logical utilities (ms-, me-, text-start), and load the CSS and the JS bundle from the same version.
- **Sources:** <https://getbootstrap.com/docs/5.0/migration/>; <https://stackoverflow.com/questions/65341620>; <https://github.com/search?q=%22bootstrap%405%22+%22data-toggle%3D%5C%22collapse%5C%22%22+language%3AHTML&type=code>; <https://www.drupal.org/project/bootstrap_barrio/issues/3223479>

## Layout overflow and clipping

Content wider or taller than its box: sideways page scroll, blown-out cards, clipped text, broken sticky.

<a name="2-page-overflow-x"></a>

### 2. Page scrolls sideways at phone widths

`page-overflow-x` | tier A | VISUAL.md: v1 `page-overflow-x` | injectors: `overflow-fixed-width`, `overflow-decorative-blob`, `overflow-nowrap-row`, `overflow-wide-pre`, `overflow-iframe-fixed`, `control-overflow-in-scroller`

- **Renders:** At 320 to 414px the document is wider than the viewport: the page pans sideways, a blank strip shows on the right, nav tabs are cut off. A masked variant hides the scroll with overflow-x hidden on html or body and clips the content instead (see `overflow-hidden-sticky`).
- **Why AI-generated code does it:** Pages are generated and reviewed in a desktop-width preview. Typical culprits: fixed pixel widths (w-[800px], min-width 900px, copied from a design), decorative absolutely positioned glow blobs with negative right offsets, carousel arrows at -left-12/-right-12 (the shadcn Carousel default), wide tables, pre blocks and 560px iframes with no scroll wrapper, images without max-width when Preflight is absent, and width 100% plus padding under content-box sizing in hand-written CSS. The common AI patch is overflow-x hidden on a wrapper, which hides the cause.
- **How common:**
  - [XCompat]: overflow symptom in 23.1% of failing (page, environment) pairs; hard-coded dimensions are the root cause on 27 of 139 failing AI pages (19.4%), hard-coded image size on 14 (10.1%).
  - [Corpus]: arbitrary pixel widths (w-[NNNpx]) in 308 of 375 repos (82%); overflow-x-hidden in 294 (78%), the usual patch.
  - [LovCommits]: 7,713 'fix "horizontal scroll"', 36,521 'fix overflow'. A Lovable QA post lists 375px horizontal scroll among six problems found in almost every Lovable app it checks.
  - [HN] Show HN: 15 comments (sideways scroll on iPhone, tabs cut off on the right). A practitioner running a screenshot loop estimated horizontal overflow at about a third of the layout bugs their agent shipped. [Reddit]: 5 strict-match posts.
  - [ReDeCheck] (human-built sites): viewport protrusion is one of the responsive failure types found in 16 of 26 live sites.
- **Detection (cost: pass):** At 360, 375 and 390px (scan mode, or the visitor's own width in page): document.scrollingElement.scrollWidth > clientWidth + 1. Find culprits by walking visible elements whose getBoundingClientRect().right > clientWidth + 1 (or left < -1) with no ancestor whose overflow-x is auto, scroll, hidden or clip; report the outermost culprit with the overflow in px and the property that sets its width (width, min-width, white-space nowrap, a long word, a transform). Re-measure after document.getAnimations() settle. Separately flag html or body with overflow-x hidden while such elements exist (masked overflow).
- **False-positive traps:** Intentional scrollers (overflow-x auto carousels, tables in scroll wrappers) contain their overflow. Off-canvas drawers translated off screen inside a clipping parent. Skip links at left -9999px (negative overflow does not scroll). Slide-in animations measured mid-flight. 1px subpixel rounding. Classic desktop scrollbars plus 100vw (see `overflow-100vw`). Fixed toasts parked off screen.
- **Fault injection:** Give a main-column block min-width 130vw; or append a 600px blurred circle at right -240px inside a non-clipping section; or set a card row to flex nowrap with four 240px children; or insert a pre with a 200-character line. Render at 375x812.
- **Fix:** Replace fixed widths with w-full and max-w-\*, add flex-wrap, give media max-width 100%, wrap tables and pre in overflow-x auto, keep decorative layers inside an overflow-x clip wrapper, use border-box sizing.
- **Sources:** <https://arxiv.org/html/2608.12518v1>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22horizontal+scroll%22&type=commits>; <https://www.reddit.com/r/lovable/comments/1wf4407/>; <https://www.reddit.com/r/Base44/comments/1q2wh6z/>; <https://news.ycombinator.com/item?id=49473167>; <https://news.ycombinator.com/item?id=47811522>; <https://dev.to/yureki_lab/how-i-gave-my-ai-coding-agent-eyes-a-screenshot-feedback-loop-for-ui-work-jce>; <https://ui.shadcn.com/r/styles/new-york/carousel.json>; <https://github.com/shadcn-ui/ui/pull/4573>; <https://polypane.app/blog/strategies-for-dealing-with-horizontal-overflows/>; <https://eprints.whiterose.ac.uk/id/eprint/116989/>; <https://www.rapidevelopers.com/md/lovable-issues/fixing-layout-issues-in-lovable-on-mobile-devices>

<a name="22-text-clipped"></a>

### 22. Text clipped or over-truncated inside fixed boxes

`text-clipped` | tier B | VISUAL.md: held back (VISUAL.md section 4: clipped text in a control) | injectors: `clip-fixed-height`, `clip-over-truncate`, `control-line-clamp-with-title`

- **Renders:** Lines cut off at the top, bottom or side of a fixed-height or overflow-hidden card, button or heading, with no ellipsis; or key text (names, prices, plan details, errors) ellipsized to a few characters with the full value nowhere on the page; mobile modals cut off at the bottom.
- **Why AI-generated code does it:** Fixed h-\* and w-\* on text containers copied from a design and tested with demo copy; overflow-hidden added for rounded corners; truncate used as the generic fix for overflow.
- **How common:**
  - [OwlEyes]: component occlusion, which includes clipped text, is 47% of mobile display issues. The multi-window GUI study found truncation rose from 1,242 to 3,528 instances under split or foldable screens. [UILens] has text overflow, cropped content and abnormal ellipsis categories; general MLLMs reached about 20% F1 on text overflow.
  - [LovCommits]: 5,389 'fix "cut off"', 7,618 'fix truncate'. [Reddit]: 7 strict, about 5 verified. [HN]: start of sentences cut on iOS Safari, cut-off nav labels.
- **Detection (cost: pass):** Elements containing text with overflow hidden or clip (self or ancestor) where scrollHeight > clientHeight + 1 or scrollWidth > clientWidth + 1, with no text-overflow ellipsis and no line-clamp; or Range.getClientRects of the text extending past the clipping ancestor. For ellipsis, flag elements showing fewer than 6 characters or under 30% of their text with no title, aria-label or other visible copy. Re-run with WCAG 1.4.12 text-spacing overrides in scan mode.
- **False-positive traps:** Intentional line-clamp with the full text reachable; collapsed read-more sections with a fade; marquees; sr-only clip; overflow auto scroll regions; icons and ripples that enlarge scrollWidth (VISUAL.md's reason to hold it back); subpixel rounding (keep 1 to 2px tolerance).
- **Fault injection:** Set height to 60% of current with overflow hidden on a text container ([Nighthawk]); or font-size 1.3x inside a fixed-height button; or add truncate to a price cell at 375px.
- **Fix:** min-height instead of height, allow wrapping, deliberate line-clamp with access to the full text, overflow auto and dvh limits on modals.
- **Sources:** <https://arxiv.org/abs/2009.01417>; <https://arxiv.org/html/2604.19081v1>; <https://openaccess.thecvf.com/content/CVPR2026/html/Xiang_UI-Lens_Assessing_General_MLLMs_Potential_to_Automate_UI_Display_Quality_CVPR_2026_paper.html>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+truncate&type=commits>; <https://news.ycombinator.com/item?id=44614893>; <https://www.w3.org/WAI/WCAG22/Understanding/text-spacing>; <https://defensivecss.dev/tips/>

<a name="26-content-blowout"></a>

### 26. Long content blows out cards and rows (min-width auto, 1fr tracks, unbreakable strings)

`content-blowout` | tier B | VISUAL.md: v1 `page-overflow-x` when it reaches the page; otherwise not covered | injectors: `blowout-long-string`, `blowout-grid-1fr`

- **Renders:** A long title, email, URL, hash or code line will not shrink: it pushes the price or button out of the card, overlaps neighbours, squeezes a sibling column to nothing, or a child pokes out of its parent box. truncate has no effect inside a flex item.
- **Why AI-generated code does it:** Flex items default to min-width auto and grid 1fr is minmax(auto, 1fr); models add truncate to the text but not min-w-0 to the flex item, and use grid-cols-[1fr\_300px] around tables or code. Demo data uses short strings, so the layout is never tested with real ones.
- **How common:**
  - [Corpus]: truncate in 184 of 375 repos (49%); 57 of 375 (15%) use truncate and never min-w-0. A probe page reproduced a row with scrollWidth 390 against clientWidth 240 until min-width 0 was added.
  - Stack Overflow 36247140 (flex items do not shrink past content size) about 210k views, 43311943 (prevent content from expanding grid items) about 400k, 1165497 (prevent text overflow) about 506k, 17779293 (text-overflow ellipsis not working) about 997k. [HN]: code blocks that blow out horizontal scroll in a slop-UI thread.
- **Detection (cost: pass):** For flex or grid containers with scrollWidth > clientWidth + 1, find the child whose rect.right passes the container's content box; flag it when computed min-width is auto and it holds a nowrap or ellipsis descendant or a text node over 30 characters with no break opportunity. Flag elements with text-overflow ellipsis that are not actually clipped. For grids, compare item rects with resolved gridTemplateColumns.
- **False-positive traps:** Intentional horizontal scrollers; pre inside overflow-x auto; decorative type bleed; marquees; items that wrap instead of overflowing.
- **Fault injection:** Insert a 60-character unbroken email into a card title inside a flex row and remove min-width 0 from the flex item; or change grid-template-columns minmax(0,1fr) 300px to 1fr 300px with a long pre in the first column.
- **Fix:** min-w-0 on flex children (min-h-0 in columns), minmax(0, 1fr), overflow-wrap anywhere for user strings, overflow-x auto on pre.
- **Sources:** <https://stackoverflow.com/questions/36247140>; <https://stackoverflow.com/questions/43311943>; <https://stackoverflow.com/questions/1165497>; <https://stackoverflow.com/questions/17779293>; <https://css-tricks.com/flexbox-truncated-text/>; <https://defensivecss.dev/tips/>; <https://news.ycombinator.com/item?id=49867038>; <https://21st.dev/blog/tailwind-css-ui-mistakes>

<a name="34-overflow-hidden-sticky"></a>

### 34. overflow-x hidden band-aid that clips content and breaks position sticky

`overflow-hidden-sticky` | tier B | VISUAL.md: not covered (masked overflow is part of the `page-overflow-x` design) | injectors: `sticky-broken-wrapper`

- **Renders:** Content past the right edge becomes unreachable instead of fixed, and sticky headers, sidebars and table heads scroll away because an ancestor became a scroll container that never scrolls. Sticky also fails when a grid stretches the aside to its parent's height or no inset is set. iOS can still pan.
- **Why AI-generated code does it:** overflow-x hidden on html, body, #root or the page wrapper is the quickest prompt-level fix for sideways scroll, and Lovable fix guides recommend it; sticky top-0 elements were generated earlier inside those wrappers.
- **How common:**
  - [Corpus]: overflow-x-hidden anywhere in 78% of repos; on a root element together with sticky elements in 17 of 375 (5%). [LovCSS]: 1,282 of 30,720 Lovable index.css files (4.2%) contain overflow-x: hidden. [LovCommits]: 11,491 'fix sticky'.
  - Stack Overflow 43707076 (how does position sticky work) about 991k views, 47095596 (body overflow-x hidden breaks sticky) about 63k. AppInstitute lists a sticky header that does not stick among common vibe-coded mobile bugs.
- **Detection (cost: pass):** For each element with computed position sticky and a top or bottom inset: find the nearest ancestor whose overflow-x or overflow-y is not visible or clip; if it is not the document scroller and its scrollHeight <= clientHeight while the document scrolls, report (confirm by scrolling 300px and checking that rect.top moved with content). Also flag a sticky grid child whose height equals its parent's. Separately, list elements past the viewport inside a root with overflow-x hidden (clipped content).
- **False-positive traps:** overflow-x clip does not create a scroll container; overflow-x hidden on body alone with html visible propagates to the viewport and sticky still works; sticky inside a real scroll pane; temporary body overflow hidden while a modal is open.
- **Fault injection:** Wrap all body children, including the sticky header, in a div with overflow-x:hidden and add one 900px element; or add html,body{overflow-x:hidden}; or remove align-self:start from a sticky grid aside.
- **Fix:** Fix the overflowing element; use overflow-x clip when clipping is wanted; align-self start for sticky grid children; set top.
- **Sources:** <https://stackoverflow.com/questions/43707076>; <https://stackoverflow.com/questions/47095596>; <https://gomakethings.com/articles/the-overflow-hidden-property-and-sticky-headers/>; <https://sizzy.co/blog/position-sticky-not-working>; <https://www.rapidevelopers.com/md/lovable-issues/fixing-layout-issues-in-lovable-on-mobile-devices>; <https://appinstitute.com/is-my-vibe-coded-app-ready/>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+sticky&type=commits>

<a name="44-button-label-nowrap"></a>

### 44. Button labels that cannot wrap, or wrap unevenly

`button-label-nowrap` | tier B | VISUAL.md: not covered | injectors: `button-long-label`

- **Renders:** Long CTA labels or translated strings overflow the button border, overlap neighbours or push the row off screen; without nowrap, labels wrap to two lines and rows get uneven heights. A probe with a French label measured scrollWidth 225 against clientWidth 158.
- **Why AI-generated code does it:** The shadcn Button base class includes whitespace-nowrap; models write short English labels and never test long ones.
- **How common:**
  - [Corpus]: 291 of 294 shadcn button.tsx files (present in 77% of repos) include whitespace-nowrap; the failure appears only with long labels.
  - W3C cites IBM: strings of 10 characters or fewer grow 200 to 300% in translation, 11 to 20 characters 180 to 200%. Hallmark lists wrap-to-two-lines clickable text.
- **Detection (cost: pass):** For button, [role=button] and [data-slot=button]: scrollWidth > clientWidth + 1, or rect.right past the parent or viewport at 375px; for wrapping, more than one line box (Range.getClientRects) in a row of single-line siblings. Pseudo-localize (add 40% length) in scan mode to surface latent cases.
- **False-positive traps:** Icon-only buttons; buttons in horizontal scrollers on purpose; multi-line tile links.
- **Fault injection:** Replace a button label with 'Continuer vers le paiement sécurisé' and set max-width:160px with white-space:nowrap.
- **Fix:** whitespace-normal with min-height, or truncate with a title; stack buttons on mobile; test pseudo-localized strings.
- **Sources:** <https://www.w3.org/International/articles/article-text-size>; <https://instagit.com/Nutlope/hallmark/what-are-the-named-ai-slop-anti-patterns.md>

<a name="59-overflow-100vw"></a>

### 59. 100vw and w-screen sections overflow by the scrollbar width

`overflow-100vw` | tier B | VISUAL.md: v1 `page-overflow-x` (needs classic scrollbars to reproduce) | injectors: `overflow-100vw-classic`

- **Renders:** width:100vw includes the vertical scrollbar, so on Windows and Linux with 15 to 17px classic scrollbars a full-bleed section adds a horizontal scrollbar; invisible on macOS overlay scrollbars and phones, where authors test.
- **Why AI-generated code does it:** w-screen reads as full width; models use it for heroes and breakout sections.
- **How common:**
  - [Corpus]: w-screen or 100vw outside components/ui in 30 of 380 repos (8%). [LovCSS]: 527 Lovable index.css files (1.7%) contain 100vw. Hallmark lists 100vw widths as an AI anti-pattern.
  - Stack Overflow 23367345 (100vw causing horizontal overflow) about 185k views; CSSWG issue 6026. Polypane notes Chromium 145 and later changed the behaviour, so newer Chromium may not reproduce.
- **Detection (cost: pass):** If innerWidth > documentElement.clientWidth (a classic scrollbar is present), flag elements whose computed width is within 1px of innerWidth and whose rect.right > clientWidth. In headless Chromium, force classic scrollbars with an injected ::-webkit-scrollbar{width:16px} during the check.
- **False-positive traps:** position fixed overlays at 100vw are clipped by the viewport; elements inside an overflow-x clip ancestor; pages with no vertical scrollbar; overlay-scrollbar environments give false negatives.
- **Fault injection:** Set width:100vw (or margin-left:calc(50% - 50vw)) on a section in a page taller than the viewport and inject ::-webkit-scrollbar{width:17px}.
- **Fix:** width:100% (or 100cqw); scrollbar-gutter stable; avoid vw for widths.
- **Sources:** <https://stackoverflow.com/questions/23367345>; <https://destroytoday.com/blog/100vw-and-the-horizontal-overflow-you-probably-didnt-know-about>; <https://lists.w3.org/Archives/Public/public-css-archive/2021Feb/0664.html>; <https://polypane.app/blog/strategies-for-dealing-with-horizontal-overflows/>; <https://instagit.com/Nutlope/hallmark/what-are-the-named-ai-slop-anti-patterns.md>

<a name="85-inner-pane-no-scroll"></a>

### 85. Full-height app shell whose inner pane grows instead of scrolling

`inner-pane-no-scroll` | tier C | VISUAL.md: not covered | injectors: `pane-min-height-removed`

- **Renders:** In chat and dashboard layouts the message or list pane grows instead of scrolling: the whole page scrolls, the composer drops below the fold, or content is cut off.
- **Why AI-generated code does it:** h-screen flex flex-col with flex-1 overflow-y-auto on the pane but no min-h-0 on an intermediate flex wrapper; chat clones are a common vibe-coded app type.
- **How common:** Stack Overflow 21515042 (scrolling a flexbox with overflowing content) about 702k views, 14962468 about 258k, 90178 (fill remaining height) about 2.07M. Mozilla bug 1042151 covers column-reverse scroll.
- **Detection (cost: pass):** An element with overflow-y auto or scroll whose scrollHeight <= clientHeight while its content extends past the viewport (it grew instead of scrolling); an app root at viewport height while documentElement.scrollHeight > innerHeight; a composer with rect.bottom > innerHeight.
- **False-positive traps:** Pages meant to scroll as a document; panes that are short by design.
- **Fault injection:** Remove min-height:0 from the flex child that wraps the scroll pane and add 100 messages.
- **Fix:** min-height 0 on every flex ancestor between the root and the scroller; flex 1 with overflow-y auto.
- **Sources:** <https://stackoverflow.com/questions/21515042>; <https://stackoverflow.com/questions/14962468>; <https://stackoverflow.com/questions/90178>; <https://bugzilla.mozilla.org/show_bug.cgi?id=1042151>

<a name="92-extra-scrollbars"></a>

### 92. Extra, nested or always-visible scrollbars

`extra-scrollbars` | tier C | VISUAL.md: not covered | injectors: `scrollbar-double`

- **Renders:** A second scrollbar, a few px of vertical overflow on every page, two scroll containers fighting, or empty scrollbar tracks on short panels (overflow scroll).
- **Why AI-generated code does it:** h-screen plus padding or borders under content-box sizing, nested overflow-auto app shells, overflow-y-scroll where auto was meant.
- **How common:** [Reddit]: 4 strict-match posts (a Lovable user who cannot get the builder to remove an extra scrollbar; a Capacitor app with tiny vertical overflow). [HN] Show HN: 2. defensivecss.dev covers scrollbars on demand.
- **Detection (cost: pass):** documentElement.scrollHeight - innerHeight between 1 and 24px (tiny overflow); more than one ancestor in the main content chain scrollable at once; computed overflow scroll with scrollHeight <= clientHeight under classic scrollbars.
- **False-positive traps:** App shells with a deliberate inner scroll (chat, IDE); long pages; overlay scrollbars hide the empty track.
- **Fault injection:** Add .app{height:100vh;padding:12px;box-sizing:content-box;overflow:auto} inside a scrolling body; change overflow-y auto to scroll on a short panel.
- **Fix:** border-box sizing, dvh with padding included, a single scroll container, overflow auto.
- **Sources:** <https://www.reddit.com/r/lovable/comments/1ki8vcw/>; <https://www.reddit.com/r/lovable/comments/1rh4hfw/>; <https://news.ycombinator.com/item?id=47606694>; <https://defensivecss.dev/tips/>

## Overlap and occlusion

Something paints on top of something the visitor needs: overlapping text, headers over anchors, overlays behind or clipped, fixed layers trapped by an ancestor.

<a name="20-fixed-header-covers"></a>

### 20. Fixed or sticky header covers content, anchor targets and focused controls

`fixed-header-covers` | tier B | VISUAL.md: v1 `focus-obscured` | injectors: `header-fixed-no-offset`

- **Renders:** A fixed top-0 navbar hides the first lines of the hero; in-page anchors (#features, #pricing) land their headings under the bar; keyboard focus moves to controls hidden under it (WCAG 2.4.11); on phones the nav wraps and the header grows to a third or half of the screen.
- **Why AI-generated code does it:** fixed top-0 w-full z-50 is the stock header; models rarely add matching padding-top, scroll-margin-top or scroll-padding-top, or mobile wrapping rules. Landing templates pair it with anchor nav and smooth scroll.
- **How common:**
  - [Corpus]: 90 of 375 repos (24%) have a sticky or fixed top header plus #anchor links or scrollIntoView and no scroll-margin, scroll-padding or offset code.
  - [LovCommits]: 27,173 'fix navbar', 112,077 'fix header' (broad). Stack Overflow 10732690 (offsetting an anchor for a fixed header) about 953k views. Product Hunt feedback and [HN] comments on navbars that cover the first words of the hero or half the mobile screen.
- **Detection (cost: hit-test):** At scrollTop 0, and after jumping to each in-page anchor (instant scrollIntoView), and after Tab focus on each focusable element: elementFromPoint at the centre of the target's first line; if the hit is a fixed or sticky element that is not an ancestor, report. Flag a header taller than 25% of innerHeight at 375px.
- **False-positive traps:** Transparent headers over hero images (imagery under the bar is fine, text is not); headers that hide on scroll down; partial coverage passes WCAG AA; JS offset handlers (check after the click handler runs).
- **Fault injection:** Make the header position:fixed;top:0 with no body padding, and remove scroll-padding-top and scroll-margin-top from section targets.
- **Fix:** position sticky, or padding-top equal to the header height; html{scroll-padding-top} or scroll-mt-\* on sections; collapse the nav on mobile.
- **Sources:** <https://stackoverflow.com/questions/10732690>; <https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+navbar&type=commits>; <https://www.producthunt.com/p/general/54682-share-your-product-here-to-get-support-feedback-users-w-c-20th-of-july>; <https://news.ycombinator.com/item?id=49817352>; <https://tetralogical.com/blog/2023/06/08/focus-in-view/>

<a name="21-overlap-elements"></a>

### 21. Overlapping text and elements

`overlap-elements` | tier B | VISUAL.md: not covered | injectors: `overlap-negative-margin`, `overlap-fixed-height`, `overlap-clone-offset`

- **Renders:** Text runs into other text or controls; cards stack on each other; absolutely positioned badges sit on titles; logo collides with nav as the viewport narrows; sections collapse onto each other after an edit. Prompting the builder to fix it often does nothing.
- **Why AI-generated code does it:** Absolute positioning used for layout (often from Figma conversions), negative margins, fixed heights on blocks whose content grows, line-height smaller than font size, and fix-one-break-another edit loops.
- **How common:**
  - [XCompat]: overlap in 5.5% of failing AI pairs. [DesignBench] real-page repair set: occlusion 18.1%. [OwlEyes]: text overlap 21% of mobile display issues. [WebCompass] uses occlusion and text overlap as defect types.
  - [LovCommits]: 36,411 'fix overlap'. [Reddit]: 5 strict plus 1 verified. Dolthub's write-up of a Claude-built page: a request made all content collapse onto itself.
- **Detection (cost: hit-test):** Pairwise intersection of visible text-bearing leaf blocks that are neither ancestor nor descendant, over 10% of the smaller rect, confirmed with elementFromPoint at line centres returning an opaque non-ancestor; use Range.getClientRects for text line boxes. In scan mode, report relations that appear at a narrower width and not at a wider one ([ReDeCheck]); confirm visibility by setting one element to opacity 0 and diffing the region ([VERVE]).
- **False-positive traps:** Avatar badges, captions on images, stacked or fanned card designs, open menus and tooltips, decorative layers with pointer-events none, boxes that collide only through invisible padding ([VERVE] non-observable).
- **Fault injection:** Add margin-top:-64px to a section heading; or give a text card height:80px with five lines; or clone a text element as position absolute offset by 0.3 of its width ([Nighthawk] style).
- **Fix:** Flow layout (flex or grid) instead of absolute positioning; min-height instead of height; line-height 1.1 or more.
- **Sources:** <https://arxiv.org/html/2608.12518v1>; <https://arxiv.org/html/2506.06251v3>; <https://arxiv.org/abs/2009.01417>; <https://arxiv.org/html/2604.18224v1>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+overlap&type=commits>; <https://www.reddit.com/r/lovable/comments/1mslshl/>; <https://dolthub.com/blog/2026-04-21-vibe-pixel-pushing/>; <https://eprints.whiterose.ac.uk/id/eprint/116989/>

<a name="30-overlay-behind"></a>

### 30. Overlays rendered behind other content (z-index and stacking contexts)

`overlay-behind` | tier B | VISUAL.md: v1 `dialog-covered` (dialogs); menus, tooltips and toasts not covered | injectors: `stack-trap-dropdown`, `stack-modal-under-header`, `control-tooltip-over`

- **Renders:** Dropdowns open under the hero, the sticky header or a map; modals sit behind the navbar; tooltips hide under the next section; raising z-index does nothing; fixing one z-index breaks another component.
- **Why AI-generated code does it:** No global layering plan: each component gets an arbitrary z-index (z-10 everywhere, z-[9999]) and fixes escalate. A z-index inside an ancestor that forms a stacking context (transform, opacity under 1, filter, will-change, isolation) cannot rise above content outside it; Framer Motion wrappers add transforms and will-change; popups are not portaled.
- **How common:**
  - [Corpus], excluding shadcn ui files: z-index 999 or more in 69 of 380 repos (18%), 9999 or more in 48 (13%). [LovCSS]: 337 Lovable index.css files contain z-index: 9999. [LovCommits]: 13,674 'fix z-index'.
  - 16x Eval z-index task: some models used invalid z-60 in a v3 project. LogRocket's seven-trap CSS test: only one of the tested tools passed the stacking-context trap cleanly. motion issues 2763 and 1837 (will-change changes stacking). Stack Overflow 5218927 (z-index with fixed positioning) about 716k views. [Reddit]: 3 strict; [HN] Show HN: 2; v0 forum: dropdowns not working in preview.
- **Detection (cost: hit-test):** When something opens (an aria-expanded=true controller, a visible role=menu/listbox/dialog/tooltip, [data-state=open], :popover-open, dialog[open]), sample a 3x3 grid inside its rect with document.elementsFromPoint; if more than 20% of samples hit non-descendants that are opaque, report the occluder and the nearest ancestor of each that creates a stacking context.
- **False-positive traps:** Top-layer elements (showModal, popover) are always on top; elementFromPoint ignores pointer-events none layers (misses visual occlusion); popups mid-animation; toasts deliberately above dialogs; the element's own backdrop child.
- **Fault injection:** Give the dropdown's ancestor position:relative;z-index:0;transform:translateZ(0) while the next section has position:relative;z-index:1; or give the sticky header z-index 9999 while the modal uses 50.
- **Fix:** Portal floating UI to body or use the top layer (dialog.showModal, popover); a documented z-index scale; isolation: isolate on sections; remove unneeded stacking contexts.
- **Sources:** <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+z-index&type=commits>; <https://eval.16x.engineer/blog/tailwind-css-v3-z-index-eval>; <https://blog.logrocket.com/ai-tool-refactor-css/>; <https://github.com/motiondivision/motion/issues/2763>; <https://stackoverflow.com/questions/5218927>; <https://github.com/shadcn-ui/ui/issues/10769>; <https://www.joshwcomeau.com/css/stacking-contexts/>; <https://www.reddit.com/r/lovable/comments/1scaod1/>

<a name="45-fixed-trapped-by-transform"></a>

### 45. Fixed overlays trapped inside a transformed, filtered or blurred ancestor

`fixed-trapped-by-transform` | tier B | VISUAL.md: not covered | injectors: `fixed-trapped-blur`

- **Renders:** A full-screen mobile menu (fixed inset-0) inside a backdrop-blur header is sized and clipped to the header strip; a modal inside a transformed page wrapper is offset or scrolls with the page. A Chrome probe measured the menu at 56px tall in a 757px viewport.
- **Why AI-generated code does it:** position fixed uses the nearest ancestor with transform, filter, backdrop-filter, perspective, contain paint/layout or will-change transform as its containing block. Glass headers with the mobile menu nested inside, and whole-page motion.div entrance transitions, are standard AI patterns.
- **How common:**
  - [Corpus]: backdrop-blur in 267 of 375 repos (71%) (exposure; the failure needs a fixed child). [LovCSS]: 3,752 of 30,720 Lovable index.css files (12%) use backdrop-filter. [LovCommits]: 6,853 'fix "mobile menu"' (one example: keep mobile menu out of hero flow).
  - WebKit bug 215256 closed as expected behaviour. Stack Overflow 15194313 (transform3d breaks fixed children) about 101k views.
- **Detection (cost: pass):** For each position fixed element that intends viewport coverage (inset 0, width 90vw or more, or role=dialog): walk ancestors for transform, filter, backdrop-filter or perspective other than none, contain paint/layout/strict/content, or will-change transform/filter; if found and the element's rect is much smaller than the viewport or clipped, report it with the trapping ancestor. Check after animations settle.
- **False-positive traps:** Fixed elements scoped to a transformed panel on purpose; transient during animations; properties on the root element do not create the containing block.
- **Fault injection:** Add backdrop-filter:blur(8px) (or transform:translateZ(0)) to the header that contains a fixed inset-0 mobile menu, then open the menu.
- **Fix:** Portal overlays to body; put the blur on a ::before layer or a sibling; clear transforms after page transitions.
- **Sources:** <https://bugs.webkit.org/show_bug.cgi?id=215256>; <https://developer.mozilla.org/en-US/docs/Web/CSS/Containing_block>; <https://stackoverflow.com/questions/15194313>; <https://meyerweb.com/eric/thoughts/2011/09/12/un-fixing-fixed-elements-with-css-transforms/>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22mobile+menu%22&type=commits>

<a name="76-fixed-bar-covers-controls"></a>

### 76. Fixed bottom bars, banners and widgets cover controls

`fixed-bar-covers-controls` | tier C | VISUAL.md: v1 `control-unreachable` | injectors: `fixed-footer-over-cta`

- **Renders:** A fixed footer, bottom nav, cookie bar or chat bubble sits over the Continue button, the last form field or footer links, even at maximum scroll.
- **Why AI-generated code does it:** position fixed bars without matching body padding; widgets pinned with no reserved space.
- **How common:** [HN] Show HN: the footer covers the Continue button on Firefox mobile. A Lovable post on a bottom nav that will not stay put. [XBIDetective]: pop-ups were the largest source of missed inconsistencies (31 of 106). [OwlEyes] component occlusion 47% (mobile).
- **Detection (cost: hit-test):** Scroll each interactive element into view (and to the document end), then elementFromPoint at its centre and corners; when the hit is a fixed or sticky element unrelated to the target, report occlusion. At mobile size, check fixed bottom bars against visualViewport.
- **False-positive traps:** Menus and modals the visitor opened; transient toasts; consent banners before dismissal (report separately); FABs over content by design.
- **Fault injection:** Add footer{position:fixed;bottom:0;left:0;right:0;height:120px;z-index:50} with no body padding-bottom.
- **Fix:** Reserve space with padding equal to the bar height; prefer sticky; place widgets away from CTAs.
- **Sources:** <https://news.ycombinator.com/item?id=49722864>; <https://www.reddit.com/r/lovable/comments/1r8wggm/>; <https://arxiv.org/html/2512.15804v1>; <https://arxiv.org/abs/2009.01417>

<a name="80-popover-clipped"></a>

### 80. Dropdowns, tooltips and date pickers clipped by an overflow ancestor

`popover-clipped` | tier C | VISUAL.md: held back (VISUAL.md section 4: popover clipped by overflow) | injectors: `popover-in-overflow-hidden`

- **Renders:** A menu inside a card with rounded-xl overflow-hidden, a table wrapper with overflow-x auto or a modal is cut off at the container edge.
- **Why AI-generated code does it:** Hand-rolled absolute dropdowns instead of portaled primitives; overflow-hidden added for rounded corners; raising z-index is tried instead of moving the menu.
- **How common:** [Boxy]: 3 of its 9 realistic mutants are this kind of clipping (scrollable table, modal clipping selects, detail panel). [LovCommits]: 3,483 'fix clipped'. shadcn #10769 (NavigationMenu with viewport false). Stack Overflow 13659545 about 43k views.
- **Detection (cost: pass):** For an open absolutely positioned floating element (menu, listbox, tooltip), intersect its rect with every ancestor clip rect (overflow other than visible) below its containing block; flag a visible fraction under 0.9 that cannot be scrolled into view.
- **False-positive traps:** Menus meant to scroll inside a container; virtualized lists; partial clipping during entrance animations; avatar and image masks.
- **Fault injection:** Add overflow:hidden to the short card or td that contains a dropdown trigger and its absolute menu, then open the menu.
- **Fix:** Portal with fixed positioning (Radix Popper, Floating UI strategy fixed) or remove the clipping.
- **Sources:** <https://github.com/luptonm/boxy>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+clipped&type=commits>; <https://github.com/shadcn-ui/ui/issues/10769>; <https://stackoverflow.com/questions/13659545>

<a name="97-next-image-fill-escapes"></a>

### 97. next/image fill escapes its box

`next-image-fill-escapes` | tier C | VISUAL.md: not covered | injectors: `fill-image-parent-static`

- **Renders:** `<Image fill>` is absolutely positioned; without a positioned parent with a height it sizes to the nearest positioned ancestor (often the page or a whole card) and covers other content, or collapses to zero height.
- **Why AI-generated code does it:** fill used as a shortcut for responsive images without the parent requirements.
- **How common:** Next.js discussion #18739 (an image spanning the whole page); issues #65890, #50067; Next.js warns about fill with a parent of invalid position.
- **Detection (cost: pass):** img[data-nimg=fill] (or any absolutely positioned inset-0 100% image) whose offsetParent is body or html, or whose rect is more than 2x its DOM parent's rect, or whose parent has 0 height.
- **False-positive traps:** Intentional full-bleed backgrounds positioned against a section that is the offsetParent.
- **Fault injection:** Remove position:relative from the parent of an absolutely positioned inset-0 image.
- **Fix:** Parent position relative with an explicit height or aspect ratio; a sizes prop.
- **Sources:** <https://github.com/vercel/next.js/discussions/18739>; <https://github.com/vercel/next.js/issues/65890>; <https://github.com/vercel/next.js/issues/50067>

<a name="106-text-occluded-by-decoration"></a>

### 106. Text painted over by decorative layers

`text-occluded-by-decoration` | tier D | VISUAL.md: partly v1 `text-invisible` (the resolver returns covered) | injectors: `decoration-over-text`

- **Renders:** FAQ answers, captions or body copy are rendered but hidden behind an absolutely positioned background image, canvas or glow layer, often in one engine only.
- **Why AI-generated code does it:** Decorative layers get position absolute and a z-index while content blocks have no position or z-index; filter, backdrop-filter or transform change stacking per engine.
- **How common:** [HN], slop-UI thread: FAQ answers invisible in Firefox desktop and hidden behind the background image in Firefox Android; other Firefox-only invisible-text reports. Causes not diagnosed.
- **Detection (cost: hit-test):** For visible text nodes, elementFromPoint at several glyph centres; flag a hit that is not the text's element or an ancestor and is an img, canvas, svg or element with a background image or opaque background; run in all three engines and diff.
- **False-positive traps:** Content under an open modal; text intentionally behind frosted glass; transparent pointer-events none layers (check opacity and background alpha).
- **Fault injection:** Inside a position relative FAQ section with unpositioned content, insert an absolute inset-0 z-index 1 div with a cover background image.
- **Fix:** Content position relative with a higher z-index, or isolation isolate on the section; decorative layers at z-index -1 with pointer-events none.
- **Sources:** <https://news.ycombinator.com/item?id=49870451>; <https://news.ycombinator.com/item?id=49867882>

<a name="107-floating-offscreen"></a>

### 107. Floating menu or tooltip opened off screen

`floating-offscreen` | tier D | VISUAL.md: not covered | injectors: `menu-offscreen`

- **Renders:** Notification dropdowns, row action menus near the bottom of a list, or tooltips open partly outside the viewport.
- **Why AI-generated code does it:** Fixed placement (always below, always right) with no collision handling.
- **How common:** [Boxy] mutants: a notification dropdown off screen and a row menu that opens downward on the last rows. No frequency found.
- **Detection (cost: pass):** Open floating elements with rect.left < 0, rect.right > innerWidth or rect.bottom > innerHeight while position is fixed or the page cannot scroll to reveal them.
- **False-positive traps:** Closed off-canvas drawers; elements mid-animation.
- **Fault injection:** Set left:calc(100% + 20px) on a dropdown, or force bottom placement on the last table row's menu.
- **Fix:** Collision-aware positioning (flip and shift) or CSS anchor positioning with fallbacks.
- **Sources:** <https://github.com/luptonm/boxy>

## Hidden or unreachable controls

Controls that exist but cannot be seen, reached or used: frozen pages, hover-only actions, missing focus, tiny targets, dialogs that cannot scroll.

<a name="8-hover-only-controls"></a>

### 8. Controls and content visible only on hover

`hover-only-controls` | tier A | VISUAL.md: not covered | injectors: `hover-only-actions`

- **Renders:** Row actions, card buttons, captions and overlay text sit at opacity 0 until mouseover. Touch users never see them; keyboard users tab onto invisible buttons. Tailwind v4 compiles hover: inside @media (hover: hover), so on touch-only devices they never appear; on v3 they stick after a tap.
- **Why AI-generated code does it:** opacity-0 group-hover:opacity-100 is a stock Tailwind polish pattern in generated cards and dashboards.
- **How common:**
  - [Corpus]: hover-only reveals in 130 of 375 repos (35%), and in 16 of 42 Tailwind v4 repos (38%), where they never show on touch.
  - [LovCommits]: 23,755 'fix hover' (mixed topics). Hallmark lists hover-only affordances as a major AI anti-pattern; the YC review of vibe-coded sites lists hover-only interactions; [HN] comments complain that buttons cannot be found until hovered.
- **Detection (cost: scan):** Find interactive elements (button, a, [role=button]) and text with effective opacity under 0.1 or visibility hidden that become visible only through :hover rules on themselves or an ancestor (scan readable CSSOM selectors containing :hover that change opacity, visibility or display of descendants; or force :hover with CDP CSS.forcePseudoState and diff). Report those with no :focus-within or :focus-visible reveal, and under emulated (hover: none) those that stay hidden.
- **False-positive traps:** Decorative hover effects; tooltips that duplicate a visible label; actions also available from a visible menu button; desktop-only tools; skip links revealed on focus.
- **Fault injection:** Inject .card .actions{opacity:0} .card:hover .actions{opacity:1} wrapped in @media (hover:hover), on cards that hold buttons; run with touch emulation.
- **Fix:** Show actions by default on (hover: none), gate the hide behind @media (hover: hover), and add a :focus-within reveal.
- **Sources:** <https://tailwindcss.com/docs/upgrade-guide>; <https://instagit.com/Nutlope/hallmark/what-are-the-named-ai-slop-anti-patterns.md>; <https://www.searchenginejournal.com/7-common-ai-website-mistakes-that-are-easy-to-avoid/574196/>; <https://news.ycombinator.com/item?id=47864393>; <https://stackoverflow.com/questions/17233804>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+hover&type=commits>

<a name="9-tap-targets-small"></a>

### 9. Touch targets too small or too close

`tap-targets-small` | tier A | VISUAL.md: held back (opt-in accessibility tier) | injectors: `tap-target-shrink`

- **Renders:** Icon buttons, close Xs, pagination dots and footer links under 24 to 44px, packed without spacing; taps miss or hit neighbours.
- **Why AI-generated code does it:** Desktop-first density: p-1 around h-4 w-4 icons, h-6 w-6 icon buttons, text-sm links with no padding, reused unchanged on mobile.
- **How common:**
  - [Harvv]: undersized or crowded tap targets on 25 of 85 AI-built sites (29%), its most frequent UI finding.
  - A dev.to axe scan of 29 AI product landing pages found target-size violations on 4. [Almanac24]: target-size is among the most common Lighthouse issues on some platforms. Base44 audit guides and a vibecoding post list it.
- **Detection (cost: pass):** Under a mobile profile, visible a, button, [role=button], input[type=checkbox|radio], summary: measure the hit rect including padding (pseudo-element extension where computable). Flag under 24x24 CSS px without a 24px spacing circle clear of other targets (WCAG 2.2 2.5.8, the axe target-size algorithm); report under 44x44 as a warning for primary actions.
- **False-positive traps:** Inline links inside sentences are exempt; hit areas enlarged by a clickable parent, a label or ::before; an equivalent larger control elsewhere; hidden controls; desktop-only tools.
- **Fault injection:** Inject nav a, footer a, button[aria-label]{padding:0;font-size:11px;line-height:1;min-height:0} and button svg{width:14px;height:14px}; or shrink a close button to 14x14px.
- **Fix:** min-h-11 min-w-11 (44px) hit areas on touch layouts, padding, and gaps between adjacent targets.
- **Sources:** <https://harvv.com/research/lovable-friction-tax>; <https://dev.to/agentkit/we-scanned-29-ai-product-landing-pages-all-29-failed-2ioc>; <https://almanac.httparchive.org/en/2024/accessibility>; <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum>; <https://www.reddit.com/r/Base44/comments/1rfkv68/>

<a name="10-focus-indicator-missing"></a>

### 10. Focus indicator removed with no replacement

`focus-indicator-missing` | tier A | VISUAL.md: held back (opt-in accessibility tier) | injectors: `focus-ring-removed`

- **Renders:** Keyboard users see no focus ring on links, inputs and buttons. In Tailwind v4 outline-none really removes the outline (v3 used a transparent outline that still showed in forced colours). A ring can also be clipped by an overflow-hidden parent. When the replacement is a box-shadow ring, Windows contrast themes remove it (`forced-colors-focus-lost`).
- **Why AI-generated code does it:** Removing the default outline for a cleaner look is a common request and pattern (Stack Overflow 3397113, about 3.08M views); generated inputs get focus:outline-none without a focus-visible: ring.
- **How common:**
  - [Corpus]: outline-none or focus:outline-none with no focus or focus-visible ring, border, shadow or background in 71 of 375 repos (19%). [LovCSS]: 379 Lovable index.css files contain outline: none.
  - [Almanac25]: about 67% of pages set outline 0 on :focus (up 14% from 2024); only about 24 to 25% use :focus-visible. [Suh] found added focus-removal violations in Qwen2.5-Coder output.
- **Detection (cost: scan):** Tab through focusable elements with real key input (CDP Input) or el.focus({focusVisible: true}) in Chromium, and diff computed outline-style/width, box-shadow, border-color, background-color and text-decoration against the unfocused state, including :focus-within ancestors and ::before/::after; or diff a crop of the element rect plus 4px. Flag no visible change, or a ring clipped by an overflow-hidden ancestor.
- **False-positive traps:** Mouse focus does not trigger :focus-visible, so non-keyboard simulation gives false alarms; indicators drawn on a parent or pseudo-element; focus moved to an inner element; tabindex=-1 elements; programmatic focus only.
- **Fault injection:** Inject \*:focus,\*:focus-visible{outline:none!important;box-shadow:none!important}.
- **Fix:** focus-visible:ring-2 with ring-offset and 3:1 contrast against adjacent colours.
- **Sources:** <https://almanac.httparchive.org/en/2025/accessibility>; <https://stackoverflow.com/questions/3397113>; <https://tailwindcss.com/docs/upgrade-guide>; <https://arxiv.org/html/2503.15885>; <https://21st.dev/blog/tailwind-css-ui-mistakes>; <https://dev.to/oqa/vibe-coding-problems-7-visual-bugs-ai-code-generators-always-ship-37mf>

<a name="31-fake-affordances"></a>

### 31. Elements styled as interactive with nothing behind them

`fake-affordances` | tier B | VISUAL.md: not covered | injectors: `fake-clickable-card`

- **Renders:** Cards, pills and 'links' get cursor pointer, hover lift or underline but do nothing on click; status badges pulse 'Live' or 'Verified' with no data behind them.
- **Why AI-generated code does it:** Hover effects (hover:scale-105, hover:shadow-lg) are applied uniformly; decorative status badges are generated without state.
- **How common:** [Harvv]: potential dead clicks (styled as interactive, no handler found) on 15 of 85 AI-built sites (18%). A widely discussed list of slop-UI tells includes pulsing badges that can never be false. ux-skill flags one identical hover effect on every element.
- **Detection (cost: scan):** Elements with computed cursor pointer or a :hover rule changing transform, shadow or background that are not a, button, summary, label or input, have no role or tabindex, and are not inside a link; then click in the harness and observe no navigation, DOM mutation or network activity within 500ms.
- **False-positive traps:** Event delegation to a parent or document; drag handles; framework listeners invisible to static checks (verify by click).
- **Fault injection:** On non-link feature cards add cursor:pointer and a hover lift with a coloured shadow; add a pulsing Live badge.
- **Fix:** Style only real controls as interactive; use semantic elements; remove stateless status badges.
- **Sources:** <https://harvv.com/research/lovable-friction-tax>; <https://godobject.dev/blog/10-tells-of-slop>; <https://github.com/Laith0003/ux-skill/wiki/How-to-detect-AI-slop-in-your-design>

<a name="33-forced-colors-focus-lost"></a>

### 33. Focus rings that vanish in Windows contrast themes (outline-none plus a box-shadow ring)

`forced-colors-focus-lost` | tier B | VISUAL.md: not covered | injectors: `focus-shadow-only-forced`, `control-focus-transparent-outline-forced`

- **Renders:** With a Windows contrast theme (forced colors) on, keyboard focus on buttons, inputs and menu items shows no indicator: the visible ring was a box-shadow, and forced colors removes box-shadow. In a Playwright Chromium render on 2026-10-13, the shadcn v4 button classes produced only a 1px border colour change on focus under forced colors (332 of 8,940 pixels changed), while the shadcn v3 button classes showed a full 2px outline. `focus-indicator-missing` covers pages that remove the outline with no replacement at all; this entry is the case where the replacement is a ring.
- **Why AI-generated code does it:** Tailwind v4 changed outline-none to set outline-style: none; the old transparent-outline behaviour, which forced colors shows, moved to outline-hidden. shadcn's v4 components, and the many v3 snippets models paste into v4 projects, pair outline-none with ring utilities, which are box-shadows. Nothing in the Lovable, v0 or bolt previews emulates forced colors.
- **How common:**
  - [Corpus] re-scan: of 40 Tailwind v4 repos with a shadcn button.tsx, 39 (98%; v0 34 of 34) pair outline-none with a ring and have no outline-based focus style. That is 39 of 377 repos (10%) today, and the share grows as projects move to v4 (36 of the 110 v0 repos are on v4 already). 1 of 377 repos has any forced-colors rule.
  - Usage: about 4% of active Windows devices used high contrast (a Microsoft figure presented to the CSS Working Group in 2019), and 30.6% of respondents to WebAIM's low-vision survey use high-contrast settings.
  - Tier B: the pattern is in 10% of repos and fails under a user setting.
- **Detection (cost: scan, with a pass-cost static hint):** Harness: emulate forced-colors active, Tab through the focusable elements, and for each one compare a crop around the element before and after focus; report when under 2% of the crop's pixels change, or when computed outline-style is none and box-shadow is the only property that changes on focus. In the page, without the setting: walk readable CSSOM rules whose selector contains :focus-visible or :focus, and report-only when a rule sets outline-style none (or outline none or 0) together with a box-shadow and changes no border width, outline or text decoration.
- **False-positive traps:** Controls whose focus style also changes border width, outline or text decoration, or adds an indicator element. Tailwind v3 outline-none, which is a transparent outline that forced colors shows. Elements that keep the browser's default focus ring. Chromium's forced-colors emulation differs slightly from Windows, so confirm a sample on Windows.
- **Fault injection:** With forced colors emulated and keyboard focus, add a rule that sets outline-style none and a 3px box-shadow ring on focused buttons, links and fields. Control: the same rule with a 2px transparent outline in place of outline-style none (the v3 behaviour, which forced colors shows).
- **Fix:** In Tailwind v4, use outline-hidden instead of outline-none, or focus-visible:outline-2 with an outline colour, and keep the ring as decoration only. Add forced-colors: variants where a control's state depends on a background colour, such as switches and selected chips.
- **Sources:** <https://tailwindcss.com/docs/upgrade-guide#renamed-outline-utility>; <https://tailwindcss.com/docs/outline-style>; <https://ui.shadcn.com/docs/tailwind-v4>; <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/forced-colors>; <https://www.smashingmagazine.com/2022/06/guide-windows-high-contrast-mode/>; <https://lists.w3.org/Archives/Public/www-style/2019Apr/0004.html>; <https://www.tempertemper.net/blog/windows-high-contrast-mode-and-focus-outlines>; <https://azukiazusa.dev/en/blog/box-shadow-focus-ring-not-visible-in-high-contrast-mode>

<a name="35-overlay-left-behind"></a>

### 35. Overlay, backdrop or scroll lock left behind after close or navigation

`overlay-left-behind` | tier B | VISUAL.md: v1 `scroll-lock-stuck` (and `click-blocked` for leftover transparent layers) | injectors: `leftover-backdrop`, `leftover-scroll-lock`, `sheet-open-after-nav`, `control-modal-open-lock`

- **Renders:** After a dialog, menu or sheet closes, or after a link in the mobile sheet navigates, the backdrop, the sheet itself or body scroll locking stays: the new page is dimmed, frozen or will not scroll.
- **Why AI-generated code does it:** Close handlers that skip cleanup; menu state local to a component and not reset on route change (the shadcn mobile Sidebar sheet did not close on item click by default); conditional rendering that unmounts mid-close.
- **How common:**
  - [SUD]: stale visibility (dialogs or notices persisting after a state change) in 48 of 308 bugs. shadcn #5561 (close sidebar on item click, mobile) 113 reactions, 34 comments; #6227.
  - [LovCommits]: 6,853 'fix "mobile menu"'. A Base44 bug list reports the mobile menu scroll lock broken.
- **Detection (cost: pass):** After a close action (Escape or close button) or a pushState/popstate: a full-viewport fixed element with a backdrop colour still visible; a [role=dialog][data-state=open] sheet still present; body or html computed overflow hidden or position fixed while no dialog is open (VISUAL.md `scroll-lock-stuck`); elementFromPoint at the viewport centre hitting an overlay.
- **False-positive traps:** Exit animations in progress (wait for transitionend plus 300ms); required consent overlays; app shells that lock body scroll by design; persistent desktop sidebars.
- **Fault injection:** On modal close leave the backdrop node mounted, or leave document.body.style.overflow='hidden'; on a mobile menu link click call history.pushState without closing the sheet.
- **Fix:** Close on route change and on link click; use dialog.close() and top-layer APIs; centralize scroll-lock cleanup on unmount.
- **Sources:** <https://arxiv.org/html/2607.04120v1>; <https://github.com/shadcn-ui/ui/issues/5561>; <https://github.com/shadcn-ui/ui/issues/6227>; <https://www.reddit.com/r/Base44/comments/1mgv1gp/>

<a name="36-empty-controls"></a>

### 36. Buttons and links with no visible label (icon failed or missing)

`empty-controls` | tier B | VISUAL.md: partly v1 `icon-font-failed`; empty accessible names not covered | injectors: `icon-button-emptied`

- **Renders:** Icon-only controls show as blank boxes when the SVG or icon font fails, or render with no accessible name at all.
- **Why AI-generated code does it:** Icon-only buttons generated without aria-label; icon libraries or fonts referenced but not loaded.
- **How common:** [WebAIM26]: empty links on 46.3% and empty buttons on 30.6% of home pages. [A11YN]: link-name violations (129 in base outputs) in LLM-generated UIs. Calo et al.: 541 semantic violations across 300 LLM-generated UIs.
- **Detection (cost: pass):** button and a with no text and no aria-label or aria-labelledby; separately, the visually empty case where the rendered box has no icon pixels (scan mode) or its svg has no child shapes.
- **False-positive traps:** Buttons with an aria-label and a visible SVG are fine; spacer links; icons still loading (wait for document.fonts.ready).
- **Fault injection:** Remove the svg child from an icon-only button, or block the icon font request.
- **Fix:** Inline SVG icons with explicit size plus an aria-label.
- **Sources:** <https://webaim.org/projects/million/>; <https://arxiv.org/html/2510.13914v1>; <https://iris.polito.it/handle/11583/3008330>

<a name="47-scroller-hidden-scrollbar"></a>

### 47. Horizontal rows with the scrollbar hidden

`scroller-hidden-scrollbar` | tier B | VISUAL.md: not covered | injectors: `scroller-scrollbar-hidden`, `control-scroller-scrollbar-visible`, `control-scroller-with-arrows`

- **Renders:** Tab bars, filter chips, galleries and card rows overflow sideways with the scrollbar hidden. On desktop the row looks complete, or merely cut off, and a mouse-wheel user cannot reach the rest, since a vertical wheel does not scroll a horizontal row. Keyboard users cannot reach it either when the items are not focusable.
- **Why AI-generated code does it:** Models add scrollbar-hide or no-scrollbar to overflow-x-auto rows so they look like a native app, usually with no arrow buttons, fade edge or other cue. Testing happens on a trackpad or a phone, where swiping works.
- **How common:**
  - [Corpus] re-scan: 32 of 377 repos (8%; Lovable 14, v0 7, bolt 11) have an overflow-x-auto or overflow-x-scroll element with a hidden-scrollbar class in the same class list, and 51 (14%) use a hidden-scrollbar utility somewhere. Hand-checked samples: tab rows, filter chips, blog filters, galleries, voice selectors.
  - [SO] 16670931 (Hide scroll bar, but while still being able to scroll): 3,248,841 views. [LovCommits]: 270 'fix "hide scrollbar"', 30 'fix "horizontal scroll" mouse'. NN/g reports that horizontal scrolling on desktop draws consistently negative responses.
  - Tier B: the pattern is in under 10% of repos and fails for mouse and keyboard users.
- **Detection (cost: pass):** Find elements with computed overflow-x auto or scroll and scrollWidth > clientWidth + 24 whose scrollbar is hidden: computed scrollbar-width none; or, under classic scrollbars, offsetHeight minus clientHeight minus borders equal to 0; or a matching ::-webkit-scrollbar { display: none } rule in the CSSOM. Require matchMedia('(pointer: fine)'), and no visible control inside the scroller or within 48 px of it whose aria-label, text or icon suggests next, previous or more. Report with the hidden width. For keyboard reach, also check for no focusable descendant beyond the visible edge and no tabindex on the scroller.
- **False-positive traps:** Touch-only contexts (pointer coarse). Scrollers with arrow buttons, pagination dots or autoplay. Rows where the last visible item is cut at the edge with a fade (a weaker cue: report-only). Marquees. Code blocks that keep their scrollbar. Scrollers whose overflow is under one item width.
- **Fault injection:** Under classic scrollbars at 1280x800, take a visible horizontal scroller, tab list or chip row (forced to nowrap in a narrower box when it does not overflow), set scrollbar-width none and a matching ::-webkit-scrollbar rule, and hide sibling arrow buttons. Controls: the same scroller with its scrollbar visible, and the same hidden scrollbar with visible next and previous buttons.
- **Fix:** Keep a thin visible scrollbar on fine-pointer devices (@media (pointer: fine)), or add next and previous buttons and a fade edge. Make the scroller focusable with tabindex=0 and an aria-label.
- **Sources:** <https://stackoverflow.com/questions/16670931>; <https://www.nngroup.com/articles/horizontal-scrolling/>; <https://lists.w3.org/Archives/Public/w3c-wai-gl/2019JanMar/0375.html>; <https://blog.logrocket.com/hide-scrollbar-without-impacting-scrolling-css>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22hide+scrollbar%22&type=commits>

<a name="54-mobile-nav-missing"></a>

### 54. Mobile navigation missing, not wired, or impossible to close

`mobile-nav-missing` | tier B | VISUAL.md: not covered | injectors: `mobile-nav-no-toggle`, `mobile-nav-dead-toggle`

- **Renders:** At phone width the nav links vanish with no hamburger, the hamburger has no handler or toggles a different element, the menu overlay covers half the page and its X does not close it, or the nav overflows in one row.
- **Why AI-generated code does it:** hidden md:flex desktop links generated first, with the mobile toggle skipped or wired to the wrong state; nav rows are single-line flex.
- **How common:**
  - [XCompat]: hidden lg:block with no replacement is a root cause on 3 of 139 failing AI pages (2.2%). [LovCommits]: 6,853 'fix "mobile menu"', 3,694 'fix hamburger'.
  - vibecoding.app guides (Bolt, Lovable) list nav not collapsing; Lovable's own navbar guide; [HN]: a menu that covers more than half the mobile page and does not close on X. A Copilot agent PR and a Jules PR add hamburger menus.
- **Detection (cost: scan):** Record header nav hrefs at 1280px; at 375px, if none are visible and no visible button with aria-expanded or aria-controls exists in the header, report; if a toggle exists, click it and expect a visible panel with the links, then press Escape or click close and expect it hidden with page scroll restored; flag a nav row whose scrollWidth exceeds clientWidth.
- **False-positive traps:** Minimal mobile headers with links repeated in the footer; bottom tab bars instead of a hamburger; menus that render after hydration (wait for idle); icon-only toggles without aria-expanded (also count visible buttons in the header).
- **Fault injection:** At max-width 767px set nav ul{display:none} and hide the menu toggle; or replace the toggle with a clone that has no listeners.
- **Fix:** A disclosure button with aria-expanded that reveals the same links, closes on Escape and route change, and handles focus.
- **Sources:** <https://arxiv.org/html/2608.12518v1>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22mobile+menu%22&type=commits>; <https://vibecoding.app/vibe-debugging/mobile-responsiveness/bolt-new>; <https://lovable.dev/guides/how-to-build-a-responsive-navbar>; <https://news.ycombinator.com/item?id=44747623>; <https://www.w3.org/WAI/WCAG20/Techniques/failures/F102>

<a name="68-pointer-events-stuck"></a>

### 68. Page frozen: body left at pointer-events none after an overlay closes

`pointer-events-stuck` | tier C | VISUAL.md: v1 `pointer-events-leak` | injectors: `body-pointer-events-none`

- **Renders:** After a dialog closes (especially one opened from a DropdownMenu item, a controlled open-state race, or a mobile Sheet open during route change) the page looks normal but ignores every click until reload.
- **Why AI-generated code does it:** Radix modal layers set pointer-events none on body; shadcn row-action menus that open edit or delete dialogs, conditional `{open && <Dialog/>}` rendering and closing on navigation are typical generated patterns.
- **How common:**
  - radix-ui/primitives #1241 (47 reactions, 108 comments, reports continuing on v1.1.15 in 2026), #1836 (39), #2122 (38), #3317 (29). shadcn-ui #1859 (43 reactions), #7237 (21 comments, open), #7929, #6227; 12 shadcn issues with pointer-events in the title, 9 titled freeze.
  - [LovCommits]: 2,748 'fix "pointer events"', 1,502 'fix "not clickable"', 684 'fix unclickable'.
- **Detection (cost: events):** Computed pointer-events of body or html is none while no [role=dialog], [role=alertdialog] or [aria-modal=true] element is visible, checked after close transitions finish (about 300ms). Very low false-report rate expected.
- **False-positive traps:** Legitimate while a modal is open or animating out; drag-and-drop libraries set it during drags; intentional full-page loading blockers.
- **Fault injection:** After a dialog closes, set document.body.style.pointerEvents = 'none'.
- **Fix:** Open the dialog after the menu closes (DropdownMenu modal={false}, or controlled state set in onSelect); keep Dialog.Root mounted and drive open; close sheets before navigating; upgrade Radix.
- **Sources:** <https://github.com/radix-ui/primitives/issues/1241>; <https://github.com/radix-ui/primitives/issues/1836>; <https://github.com/radix-ui/primitives/issues/2122>; <https://github.com/radix-ui/primitives/issues/3317>; <https://github.com/shadcn-ui/ui/issues/1859>; <https://github.com/shadcn-ui/ui/issues/7237>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22pointer+events%22&type=commits>

<a name="69-dialog-unreachable"></a>

### 69. Dialog or sheet taller than the viewport with no way to scroll

`dialog-unreachable` | tier C | VISUAL.md: v1 `dialog-covered` (buttons off-screen) | injectors: `dialog-overflow-tall`

- **Renders:** A long form inside a centred fixed dialog or sheet runs past the top and bottom of the screen; with page scroll locked and no max-height or overflow on the content, Save is unreachable, worst on phones with the keyboard open.
- **Why AI-generated code does it:** shadcn DialogContent is fixed top-[50%] translate-y-[-50%] with no max-height or overflow in the current v4 registry source; forms grow across prompt iterations inside a dialog sized for the first version.
- **How common:** shadcn-ui #16 (dialog overflow behaviour) 151 reactions, 70 comments; #2820 (Sheet hides Save) 11 reactions. [Reddit]: 4 strict-match posts (Base44 3: modals off screen and unclickable, too big). [LovCommits]: 45,113 'fix modal', 42,591 'fix dialog' (mixed topics).
- **Detection (cost: pass):** For an open [role=dialog] or [aria-modal=true]: rect.bottom > innerHeight + 1 or rect.top < -1, and no element between it and the overlay is scrollable with remaining scroll; list focusables outside the viewport.
- **False-positive traps:** Overlays that scroll themselves; entrance transforms mid-animation; full-screen sheets that scroll internally.
- **Fault injection:** Append 25 form fields to an open dialog and set max-height:none;overflow:visible on its content; load at 390x640.
- **Fix:** max-h-[calc(100dvh-2rem)] overflow-y-auto on the content (or a scrolling overlay) with a sticky footer.
- **Sources:** <https://github.com/shadcn-ui/ui/issues/16>; <https://github.com/shadcn-ui/ui/issues/2820>; <https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/dialog.tsx>; <https://www.reddit.com/r/Base44/comments/1omxlmk/>

<a name="75-click-blocked"></a>

### 75. Invisible layer intercepts clicks

`click-blocked` | tier C | VISUAL.md: v1 `click-blocked` | injectors: `transparent-overlay-cta`, `control-pointer-none-decoration`

- **Renders:** Buttons and links look fine but do not respond: a transparent decorative layer (absolute inset-0 gradient, glow, noise overlay) or a closed menu hidden only with opacity 0 sits on top.
- **Why AI-generated code does it:** Layered hero decorations with z-10 and no pointer-events none; opacity-only hide transitions.
- **How common:** [LovCommits]: 1,502 'fix "not clickable"', 684 'fix unclickable', 2,748 'fix "pointer events"' (examples include fixing pointer events in a hero). A practitioner field guide to vibe-coding bugs lists it.
- **Detection (cost: hit-test):** For each visible interactive element, scroll it to the viewport centre and test elementFromPoint at its centre and two interior points; if the hit is neither the element, a descendant nor its label, and the hit is visually transparent (opacity under 0.05, or transparent background with no text or border), report the covering element.
- **False-positive traps:** pointer-events none layers are not hit; icon spans inside buttons; opacity-0 native inputs over styled boxes (custom checkboxes); an open modal backdrop; sticky headers mid-scroll.
- **Fault injection:** Append `<div style="position:absolute;inset:0;z-index:10"></div>` inside the hero, over the CTA, in a position relative section.
- **Fix:** pointer-events-none on decorations; visibility hidden or pointer-events none on closed menus.
- **Sources:** <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22not+clickable%22&type=commits>; <https://wonderingaboutai.substack.com/p/a-field-guide-to-11-common-vibe-coding>

<a name="84-interaction-states-missing"></a>

### 84. Hover, active and disabled states missing or overridden by !important

`interaction-states-missing` | tier C | VISUAL.md: not covered | injectors: `important-blocks-hover`, `disabled-looks-enabled`

- **Renders:** Buttons give no feedback on hover or press; disabled buttons look enabled; accumulated !important declarations make hover, focus, disabled and dark rules lose.
- **Why AI-generated code does it:** Models emit only the default state unless asked; successive fixes each add !important instead of fixing structure.
- **How common:** [LovCSS]: 2,800 of 30,720 Lovable index.css files (9.1%) contain !important. LogRocket's test: ChatGPT, Claude, Copilot, Cursor and Gemini all failed the !important hover-cascade trap. A Reddit thread (February 2026) on Claude adding !important per bug report. OverlayQA (vendor) says Figma Make consistently ignores interaction states; Lovable and Base44 posts and audit guides say hover and focus states are usually missing.
- **Detection (cost: scan):** Force :hover and :active (CDP CSS.forcePseudoState) on buttons and links and diff computed styles; [disabled] or aria-disabled elements whose styles equal enabled siblings; CSSOM state rules (:hover, :focus-visible, :disabled, .dark) whose values never take effect because a non-state !important declaration wins.
- **False-positive traps:** Hover drawn on a parent (group-hover); cursor-only changes; touch sessions; Tailwind ! modifiers used deliberately where no state styling is intended.
- **Fault injection:** Inject .btn,button{background-color:#2563eb!important} so hover never applies; delete CSSOM rules whose selectors contain :hover or :active for buttons; style disabled buttons like enabled ones.
- **Fix:** Define hover, active, focus-visible and disabled styles per component; remove !important and use @layer and specificity.
- **Sources:** <https://blog.logrocket.com/ai-tool-refactor-css/>; <https://overlayqa.com/blog/ai-app-builders-visual-bugs/>; <https://www.reddit.com/r/lovable/comments/1x1k7b1/>; <https://www.reddit.com/r/Base44/comments/1riyqgz/>; <https://str-webdesign.com/blog/how-to-fix-a-vibe-coded-website-a-web-designers-honest-guide>

<a name="88-touch-click-through"></a>

### 88. Select option tap activates the element behind it

`touch-click-through` | tier C | VISUAL.md: not covered | injectors: `listbox-remove-on-pointerdown`

- **Renders:** On touch devices, choosing a Select option closes the listbox and the follow-up click lands on the link or button underneath, triggering navigation or another action.
- **Why AI-generated code does it:** Radix Select is the default select in shadcn-generated forms.
- **How common:** radix-ui/primitives #1658 (117 reactions, 106 comments).
- **Detection (cost: scan):** Interaction test under touch emulation: open a Select whose option overlaps another interactive element, tap the option, report click events on elements outside the select within 500ms.
- **False-positive traps:** Version-dependent; needs touch input emulation; no static signal.
- **Fault injection:** Remove the listbox on pointerdown so the click resolves to the element beneath.
- **Fix:** Upgrade Radix; delay close or preventDefault the trailing click.
- **Sources:** <https://github.com/radix-ui/primitives/issues/1658>

<a name="89-popover-in-dialog-no-scroll"></a>

### 89. Popover or combobox list inside a dialog will not scroll

`popover-in-dialog-no-scroll` | tier C | VISUAL.md: not covered | injectors: `popover-wheel-blocked`

- **Renders:** Command, Combobox and Popover lists opened inside a Dialog ignore wheel and touch scrolling, so options past the first screen are unreachable.
- **Why AI-generated code does it:** The dialog's scroll lock only allows its own subtree and the popover is portaled elsewhere; shadcn Combobox inside a form Dialog is a common generated composition.
- **How common:** shadcn-ui #6988 (7 reactions), #4799, #3959, PR #2412.
- **Detection (cost: scan):** For an open floating list with scrollHeight > clientHeight while a modal lock is active, dispatch a real wheel event (CDP Input.dispatchMouseEvent) at its centre and report when scrollTop does not change.
- **False-positive traps:** Synthetic DOM events are ignored by some libraries (use CDP input); lists not meant to scroll.
- **Fault injection:** Add a capture-phase wheel listener on document that calls preventDefault() for targets inside the popover.
- **Fix:** Render the popover inside the dialog content, or make the Popover modal; upgrade Radix.
- **Sources:** <https://github.com/shadcn-ui/ui/issues/6988>; <https://github.com/shadcn-ui/ui/issues/4799>; <https://github.com/shadcn-ui/ui/pull/2412>

<a name="98-unexpected-hidden"></a>

### 98. Controls hidden or collapsed by a wrong state class

`unexpected-hidden` | tier C | VISUAL.md: not covered | injectors: `nav-items-hidden`, `sidebar-zero-width`

- **Renders:** Elements that should show are visibility hidden, opacity 0 or zero size: nav items vanish, pagination is invisible, a sidebar collapses to 0 instead of icon width.
- **Why AI-generated code does it:** State-toggling classes applied wrongly; regeneration that rewrites component boundaries.
- **How common:** [Boxy] mutants: sidebar collapse to 0, nav items visibility hidden, pagination opacity 0. [MAEWU]: of 250 real web-app bug reports, 44% affected the UI and 19% of those concerned appearance.
- **Detection (cost: pass):** Interactive or named elements that are in layout but have opacity 0, visibility hidden or zero size, are not aria-hidden and not inside a closed disclosure; containers at zero width hiding children through overflow; sampled after transitions end.
- **False-positive traps:** Closed menus, inactive tab panels, skip links, elements mid-transition.
- **Fault injection:** visibility:hidden on nav items; opacity:0 on pagination; width:0;overflow:hidden on a collapsed sidebar.
- **Fix:** Correct the state classes; keep a visible collapsed state.
- **Sources:** <https://github.com/luptonm/boxy>; <https://people.ece.ubc.ca/amesbah/resources/papers/icsme21.pdf>

<a name="101-focus-behind-overlay"></a>

### 101. Popups and drawers that cover the page but leave focus behind them

`focus-behind-overlay` | tier C | VISUAL.md: not covered | injectors: `popup-no-focus`

- **Renders:** Newsletter popups, cart drawers and size guides cover content while keyboard focus stays on the page underneath: focus is invisible and lands on controls behind the overlay.
- **Why AI-generated code does it:** Overlays built as plain fixed divs without dialog semantics or focus management.
- **How common:** accessiBe (vendor) June 2026 WCAG 2.2 audits: both Lovable-built storefronts had critical findings for popups and drawers without a dialog role and with focus not moved or trapped.
- **Detection (cost: hit-test):** A visible fixed element covering more than 30% of the viewport while document.activeElement is outside it and under it (elementFromPoint at the activeElement centre hits the overlay); after opening a dialog, Tab and check focus stays inside.
- **False-positive traps:** Non-modal banners that do not overlap focusable content; overlays mid-animation.
- **Fault injection:** Add a fixed inset-0 newsletter div with a centred card, no role, no focus move and no inert on the background.
- **Fix:** `<dialog>.showModal()` or role=dialog with focus moved in, trapped and returned on close.
- **Sources:** <https://accessibe.com/accessibility-platform/reports/gen-ai-ecommerce/accessibility-audit>; <https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured>

## Template and data leaks

Things that should never reach a visitor: placeholder copy, null and NaN, mojibake, builder branding, default share previews, scaffold CSS.

<a name="14-placeholder-content"></a>

### 14. Template placeholder content left visible

`placeholder-content` | tier A | VISUAL.md: v1 `text-placeholder` | injectors: `placeholder-text`

- **Renders:** John Doe testimonials, 123 Main St, +1 (555) phone numbers, example.com emails, Your Company, lorem ipsum, FAQ items with no answer, and navigation links to #. Placeholder YouTube embeds are a separate entry (`embed-placeholder-video`).
- **Why AI-generated code does it:** Generators fill layouts with stand-in data and the owner never replaces it.
- **How common:**
  - [Corpus]: placeholder contact text in 44 of 375 repos (12%); lorem ipsum in 2 (1%). VideoVIBE's taxonomy names unreplaced placeholder exposure.
  - A Peerlist parody site of AI-coded websites mocks unfilled template variables and dead navbar links; an HN reviewer notes an FAQ section without answers. ux-skill treats lorem ipsum as zero tolerance.
- **Detection (cost: pass):** Regex over visible text nodes: lorem ipsum, John/Jane Doe, 555- phone patterns, example.com addresses, Your (Name|Company|Logo); details or accordion panels with no text; primary nav links with href="#". Report once per string.
- **False-positive traps:** Docs and demo pages that show examples on purpose; form placeholder attributes (not visible content); real people named John Doe; Acme as a real brand.
- **Fault injection:** Replace a testimonial author with John Doe, a footer phone with +1 (555) 123-4567, and clear the text of one FAQ answer panel.
- **Fix:** Content review before publish; a CI grep for placeholder strings.
- **Sources:** <https://arxiv.org/html/2608.09573>; <https://peerlist.io/saxenashikhil/articles/every-aicoded-website-ever>; <https://github.com/Laith0003/ux-skill/wiki/How-to-detect-AI-slop-in-your-design>; <https://news.ycombinator.com/item?id=49867038>

<a name="15-share-preview-default"></a>

### 15. Default or missing social share preview

`share-preview-default` | tier A | VISUAL.md: not covered (served HTML, not the rendered page) | injectors: `og-image-removed`, `og-image-builder-default`

- **Renders:** Links shared on WhatsApp, LinkedIn, X or Discord show the builder's placeholder card, the favicon, a bare URL or a broken image; every route previews the same.
- **Why AI-generated code does it:** A client-rendered SPA serves one index.html, so crawlers that do not run JS see template meta; models rarely add og:image and twitter:card unless asked; per-route react-helmet tags are invisible to crawlers. The Lovable template's index.html ships og:image https://lovable.dev/opengraph-image-p98pqg.png and twitter:site @lovable\_dev, and the model never replaces them. Next.js projects need openGraph.images in their metadata or an opengraph-image file, which v0 rarely writes.
- **How common:**
  - [Corpus] re-scan: in Lovable index.html files, 53 of 158 (34%) still point og:image at lovable.dev, 60 (38%) have no og:image, and 45 (28%) have a custom one. In v0, 103 of 110 repos (94%) define no Open Graph image (no openGraph.images in metadata and no opengraph-image or twitter-image file). In bolt, 82 of 109 (75%) have no og:image anywhere.
  - [Reddit]: 72 strict-match posts (Lovable 30, vibecoding 23, Base44 11), about 60% on topic. A Lovable QA post lists a share preview still showing the Lovable placeholder among six problems in almost every Lovable app; Base44 users report the OG image defaulting to the favicon.
  - Tier A since the gap review (tier B before, on the 72 posts): the template default or a missing image produces the defect on every share by itself, which is the catalog's rule for counting exposure toward tier A. It is ranked last in tier A because the rates come from a static scan and the defect shows off the page.
- **Detection (cost: scan):** Fetch the raw HTML with a crawler user agent (not the hydrated DOM); read meta[property='og:image'] and twitter:image; flag missing, a known builder placeholder host, the same value on every route, or a URL that returns 404 or a non-image. Report the template default (an og:image on lovable.dev) and a missing og:image as separate kinds.
- **False-positive traps:** Sites that intentionally use one site-wide card; previews injected by an edge worker (fetch with a crawler UA first); pages not meant to be shared.
- **Fault injection:** Remove og:image and twitter:card from head, or point og:image at a placeholder URL that 404s; or set og:image to the Lovable template image and twitter:site to @lovable\_dev.
- **Fix:** Per-page og tags at build or edge with a real 1200x630 image.
- **Sources:** <https://www.reddit.com/r/lovable/comments/1wf4407/>; <https://www.reddit.com/r/lovable/comments/1q4jv3q/>; <https://www.reddit.com/r/Base44/comments/1nzboqs/>; <https://github.com/search?q=%22lovable.dev%2Fopengraph-image%22&type=code>; <https://nextjs.org/docs/app/api-reference/file-conventions/metadata/opengraph-image>; <https://ogp.me/>

<a name="28-llm-markdown-raw"></a>

### 28. AI answers shown as raw markdown (literal asterisks, # and pipes)

`llm-markdown-raw` | tier B | VISUAL.md: not covered | injectors: `markdown-raw-text`, `control-markdown-in-code`, `control-markdown-rendered`

- **Renders:** Chatbots, summaries, 'AI insights' cards and generated descriptions show `**bold**`, `## headings`, `- bullets` and `|---|` table rows as literal characters in a paragraph, often inside a whitespace-pre-wrap block. While a response streams, half-written markers flicker.
- **Why AI-generated code does it:** The generated app sends a prompt to an LLM (OpenAI, Gemini through the Lovable AI gateway, Anthropic, OpenRouter) whose default output is markdown, then renders the string with {message.content} inside a `<p>`. Adding react-markdown or a streaming-safe renderer is a separate step that the model often skips.
- **How common:**
  - [Corpus] re-scan: 73 of 377 repos (19%; Lovable 34, v0 17, bolt 22) call an LLM API or SDK, and 54 of those 73 (74%) have no markdown renderer (react-markdown, marked, markdown-it, streamdown, markdown-to-jsx and others), 14% of all repos. In a 10-repo sample of the 54, 6 print model text into a plain `<p>` or a whitespace-pre-wrap element.
  - [LovCommits]: 5,349 'fix markdown', 880 'fix "markdown rendering"', 642 'fix markdown chat', 573 'fix asterisks', 73 'fix "raw markdown"'.
  - Outside the builders: a Google AI developer forum thread on asterisks in Gemini responses (the reply says to render the markdown), and a Cursor forum report of bold and code shown as raw syntax. Strict Reddit regexes found too few posts to count.
  - Tier B: exposure is 14% of all repos, and the bug shows whenever the model returns markdown.
- **Detection (cost: pass):** Scan visible text blocks outside code, pre, kbd, samp, textarea, input and contenteditable for at least two markdown markers in one block: paired double asterisks around 2 to 80 characters, a line starting with 1 to 6 # characters and a space, two or more lines starting with `- `, `* ` or `1. ` in one text node, a table delimiter row (`|---|`), or a triple-backtick fence. Weight findings up inside elements whose class, role or aria-live suggests chat or AI output.
- **False-positive traps:** Markdown editors and source previews. Documentation that teaches markdown. Code samples. Product names that contain asterisks, and footnote asterisks. Hashtags (#tag with no space). ASCII art. A single asterisk pair in a user-typed chat message (report on assistant messages only, when the role is known).
- **Fault injection:** Replace a visible paragraph's text with a short markdown answer (bold, a heading, two bullets and a table header) and set white-space pre-wrap. Controls: the same markdown inside `<pre><code>`, and the same words rendered as proper HTML (strong, h2, ul, table).
- **Fix:** Render model output with react-markdown, or Streamdown for streaming, plus a sanitizer. Or ask the model for plain text or structured JSON and lay it out in components.
- **Sources:** <https://discuss.ai.google.dev/t/asterisk-in-gemini-response/47067>; <https://forum.cursor.com/t/chat-markdown-in-ai-replies-not-rendering-bold-and-code-show-as-raw-syntax/152531>; <https://streamdown.ai/docs>; <https://stackoverflow.com/questions/31875748>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22markdown+rendering%22&type=commits>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+asterisks&type=commits>

<a name="40-builder-branding"></a>

### 40. Builder branding and template defaults left on the live site

`builder-branding` | tier B | VISUAL.md: not covered | injectors: `builder-badge-and-title`, `title-template-default`, `control-title-with-app`

- **Renders:** A floating Edit with Lovable badge or Made with stamp on client sites; the builder's or Vite's favicon; Vite + React + TS as the page title; branding returning when a paid plan lapses; the old favicon kept in search results.
- **Why AI-generated code does it:** Platform-injected badges, template favicons and default titles that the generator never replaces: 'v0 App' from v0's layout.tsx metadata, 'Lovable App' and 'Lovable Generated Project' from the Lovable index.html, 'Create Next App' from create-next-app, and 'Vite + React + TS' from create-vite.
- **How common:**
  - [Reddit]: 46 strict-match posts (Lovable 39, Base44 5), about 75% on topic: agencies asking how to remove the badge from client sites, the badge showing as the favicon in Google, a favicon not updating after a week.
  - [Corpus] re-scan: 35 of 377 repos (9%) still have a default title: 'v0 App' in 18 of 110 v0 repos (16%) plus 1 Lovable repo, 'Create Next App' in 7 (bolt 5, v0 2), 'Lovable App' in 5 Lovable repos, 'Vite + React + TS' in 3 bolt repos and 'Vite + React' in 1. The description meta 'Lovable Generated Project' remains in 39 of 158 Lovable index.html files (25%). Tier B stands.
- **Detection (cost: pass):** DOM scan for known badge text and ids, fixed bottom-right iframes or anchors pointing at builder domains; link[rel=icon] pointing at template assets (vite.svg, a known default favicon hash) or a builder CDN; document.title (read after settle) or meta[name=description] exactly equal to a template default: v0 App, Lovable App, Lovable Generated Project, Create Next App, Vite + React + TS, Vite + React, React App.
- **False-positive traps:** Plans that require the badge; builder showcase sites; a builder's own pages; internal tools and demo apps where nobody sees the title; titles set at runtime after load.
- **Fault injection:** Append a fixed bottom-right anchor 'Edit with Lovable' pointing at the builder; set link rel=icon to /vite.svg and the title to Vite + React + TS; or, in the served HTML, set the title to Vite + React + TS and the description meta to Lovable Generated Project. Control: a real product title that contains the word App.
- **Fix:** Remove or hide the badge per plan rules, replace the favicon set and title, request a re-crawl.
- **Sources:** <https://www.reddit.com/r/lovable/comments/1ua2lns/>; <https://www.reddit.com/r/lovable/comments/1qdeq3f/>; <https://www.reddit.com/r/Base44/comments/1wugkv2/>; <https://www.rapidevelopers.com/md/lovable-issues/adding-favicon-or-app-icon-to-a-lovable-project>; <https://github.com/search?q=%22Lovable+Generated+Project%22&type=code>; <https://github.com/search?q=%22title%3A+%27v0+App%27%22&type=code>

<a name="52-template-text-leak"></a>

### 52. Literal null, undefined, NaN, [object Object] or template syntax rendered

`template-text-leak` | tier B | VISUAL.md: v1 `text-template-leak` | injectors: `template-leak-text`, `control-code-block-null`

- **Renders:** Visitors see `undefined`, `null`, `NaN`, `$NaN`, `[object Object]`, `Invalid Date` or raw `{{var}}` where content should be, often in prices, names and dates.
- **Why AI-generated code does it:** String templates over missing fields, parsing that yields NaN, objects passed to text, unrendered template syntax.
- **How common:** [OwlEyes] (mobile, not AI): NULL value is 6% of display issues. The multi-window GUI study detected 46 null displays. [WebCompass] has a data and content error category. A parody of AI-coded sites mocks unfilled template variables.
- **Detection (cost: pass):** Visible text tokens matching `\b(undefined|null|NaN|Invalid Date)\b` or `\[object Object\]`, or containing `{{` or `${`; weight higher inside price, name and date elements.
- **False-positive traps:** code, pre and contenteditable; programming docs; ordinary words (null hypothesis); exclude by element type and context.
- **Fault injection:** Replace a price's text with $NaN and a name with undefined; replace a heading with {{headline}}.
- **Fix:** Guard rendering and give missing data a fallback.
- **Sources:** <https://arxiv.org/abs/2009.01417>; <https://arxiv.org/html/2604.19081v1>; <https://arxiv.org/html/2604.18224v1>; <https://peerlist.io/saxenashikhil/articles/every-aicoded-website-ever>

<a name="61-embed-placeholder-video"></a>

### 61. Placeholder YouTube embeds that play Rick Astley

`embed-placeholder-video` | tier B | VISUAL.md: not covered (`text-placeholder` could take it as one more placeholder pattern) | injectors: `embed-rickroll-placeholder`, `control-embed-real-video`, `control-embed-id-in-code`

- **Renders:** A demo, tutorial, testimonial or 'watch the video' embed on a client or launch site plays 'Never Gonna Give You Up' (YouTube id dQw4w9WgXcQ), because the model used it as the placeholder video.
- **Why AI-generated code does it:** Asked for a sample YouTube URL or a placeholder video, models reproduce the best-known YouTube id in their training data. The embed loads and plays, so nothing in the build or preview flags it.
- **How common:**
  - [Reddit] (86,113 posts after title dedupe): 23 posts about being rickrolled by the builder or agent (vibecoding 10, cursor 4, replit 3, Base44 2, lovable 2, boltnewbuilders 1, windsurf 1), 22 of them readable and on topic. Several are client work, and one says Claude Code picked Rick Astley when asked for a placeholder YouTube video. r/ClaudeCode adds 6 titles (Arctic Shift search).
  - [Corpus] re-scan: 4 of the 16 repos that contain YouTube ids (25%) use dQw4w9WgXcQ in dummy data or default components, 1% of all repos. GitHub code search: 14,592 TSX files contain dQw4w9WgXcQ. [LovCommits]: 15 'fix "rick"', which counts only the commits that name it.
  - Tier B: a measured rate under 10% in AI output, plus posts.
- **Detection (cost: pass):** Check iframes whose src contains youtube.com/embed/ or youtube-nocookie.com/embed/, lite-youtube elements, and links to youtube.com/watch or youtu.be, and report any whose video id is in a placeholder list (dQw4w9WgXcQ first; extend the list from the corpus). Report it as placeholder content and name the element. Cheap, and close to zero false reports outside music and meme sites.
- **False-positive traps:** Sites that intend the rickroll (jokes, meme pages, music blogs, 404 pages). Test fixtures on hidden admin pages. Code samples that print the id as text.
- **Fault injection:** Point a visible YouTube iframe at the dQw4w9WgXcQ embed, or insert a 560x315 embed of it into a section. Controls: an embed of a live id that is not on the placeholder list (jNQXAC9IVRw, oEmbed 200 on 2026-10-13), and a code block that prints the placeholder id as text.
- **Fix:** Use the owner's real video or remove the section, and search the codebase for dQw4w9WgXcQ before launch.
- **Sources:** <https://www.reddit.com/r/vibecoding/comments/1plfo5k/>; <https://www.reddit.com/r/lovable/comments/1qzdi5o/>; <https://www.reddit.com/r/cursor/comments/1kak51t/>; <https://www.reddit.com/r/boltnewbuilders/comments/1q2ng1p/>; <https://www.reddit.com/r/Base44/comments/1x2r2xy/>; <https://www.reddit.com/r/replit/comments/1kvo7g8/>; <https://www.reddit.com/r/ClaudeCode/comments/1sjfwq6/>; <https://github.com/search?q=%22dQw4w9WgXcQ%22+language%3ATSX&type=code>

<a name="99-mojibake"></a>

### 99. Mojibake and replacement characters

`mojibake` | tier C | VISUAL.md: v1 `text-encoding` | injectors: `mojibake-text`

- **Renders:** Text shows sequences like a-circumflex plus euro sign instead of dashes and quotes, U+FFFD boxes, or double-escaped entities (&amp;amp;).
- **Why AI-generated code does it:** UTF-8 text decoded as Windows-1252 somewhere in a pipeline (CMS import, CSV, API); missing charset meta.
- **How common:** [Reddit]: 2 posts (Lovable, Replit). [Corpus] re-scan: 0 of 377 repos show mojibake sequences in rendered source text; 2 have U+FFFD only in a code comment or an unused \_OLD file. Measuring it needs rendered apps with real data, not source scans. Low priority.
- **Detection (cost: pass):** Text nodes matching mojibake byte patterns (Ã followed by a Latin-1 character, the encoded em dash or curly quote sequences), U+FFFD, or `&amp;[a-z]+;` patterns.
- **False-positive traps:** Pages that discuss encoding; languages that legitimately use those characters.
- **Fault injection:** Replace curly quotes and dashes in a paragraph with their Windows-1252 misdecoded forms.
- **Fix:** UTF-8 end to end with a charset meta.
- **Sources:** <https://www.reddit.com/r/lovable/comments/1rtpdu1/>

<a name="104-starter-template-css"></a>

### 104. Starter-template CSS left in place (Vite centring, Next colour-scheme defaults)

`starter-template-css` | tier D | VISUAL.md: not covered | injectors: `vite-template-centering`

- **Renders:** The app renders as a narrow centred column (Vite's index.css: body display flex with place-items center, #root max-width 1280px, padding 2rem, text-align center), or flips to dark text colours on dark-mode machines (Next's globals.css switches --background and --foreground under prefers-color-scheme).
- **Why AI-generated code does it:** Generators add their layout on top of the scaffold files and never remove index.css, App.css or globals.css defaults.
- **How common:** No counted complaints; the mechanism is documented in the template sources and a Next.js discussion where a new project showed dark unexpectedly. A cheap deterministic check.
- **Detection (cost: pass):** body computed display flex with place-items center plus #root max-width 1280px; or :root color-scheme light dark with colour rgba(255,255,255,0.87) and background #242424 (Vite) while the app sets its own background; or a prefers-color-scheme block that sets only --background and --foreground.
- **False-positive traps:** Apps that intentionally keep a centred column; sites that support both themes properly.
- **Fault injection:** Add body{display:flex;place-items:center;min-height:100vh} #root{max-width:1280px;margin:0 auto;padding:2rem;text-align:center}.
- **Fix:** Delete scaffold CSS when adopting a layout.
- **Sources:** <https://gist.github.com/demarchenac/d36ab5becc363bdfe212e3d3ae986b0a>; <https://github.com/vercel/next.js/discussions/40866>

## Blank page and missing content

The page or parts of it render nothing.

<a name="5-page-blank"></a>

### 5. Blank or white screen instead of the app

`page-blank` | tier A | VISUAL.md: v1 `page-blank` | injectors: `blank-root-hidden`, `blank-root-emptied`

- **Renders:** The page loads but shows nothing, or only a background colour. Variants: blank only after deploy, only on iPhone, only on unknown routes (no catch-all 404), only inside the builder preview. Two causes have their own entries: a host 404 page on direct links and refreshes (`spa-deep-link-404`), and a failed lazy chunk after a redeploy (`stale-chunk-blank`).
- **Why AI-generated code does it:** Client-rendered SPAs with no error boundary, so one render error (often a hallucinated or renamed import such as a lucide icon) unmounts the whole tree. Also missing production env vars, a wrong router base path, links to routes that do not exist, Safari-only JS, and translation extensions mutating the DOM.
- **How common:**
  - [Reddit]: the most frequent visual complaint in builder subreddits, 190 strict-match posts (Lovable 63, Base44 39, Replit 37, vibecoding 26, bolt 19); about 11 of a 15-post sample were about the poster's own app.
  - [v0forum]: 16 topic titles about blank screens; [AIStudio]: 9. [HN] Show HN: 57 comments mention a blank page (mixed causes, including no-JS and Firefox-only).
  - [LovCommits]: 10,275 'fix "blank screen"', 8,114 'fix "white screen"'. Bolt's support docs have a page for white or grey preview screens.
- **Detection (cost: pass):** After the settle gates (VISUAL.md 2.3) in a visible tab: the app root (#root, #\_\_next, body > div) has no visible descendant with text or media larger than 2x2px, or innerText under 10 characters; correlate with uncaught errors from window error and unhandledrejection. In scan mode repeat at a phone width and at an unknown route.
- **False-positive traps:** Splash or loading screens still within budget; pages still hydrating; canvas and WebGL apps whose content is in a canvas; auth redirects in flight; hidden or occluded tabs, where rAF and IntersectionObserver pause (the known GenClass hidden-tab artifact); prerender.
- **Fault injection:** After load, set #root or #\_\_next to display none, or call root.replaceChildren(); variant: body > \* { visibility: hidden } while the body background stays.
- **Fix:** Add an error boundary with a visible fallback and a catch-all 404 route; check env vars at build; read the console error before re-prompting.
- **Sources:** <https://www.reddit.com/r/lovable/comments/1o3dqbb/>; <https://www.reddit.com/r/boltnewbuilders/comments/1jdgsis/>; <https://www.reddit.com/r/lovable/comments/1wf4407/>; <https://community.vercel.com/t/blank-screen-after-deployment/9530>; <https://community.vercel.com/t/v0-preview-render-shows-blank-screen-while-production-works-correctly/37914>; <https://discuss.ai.google.dev/t/the-preview-opens-but-shows-only-a-blank-white-screen/184423>; <https://support.bolt.new/troubleshooting/preview-issues>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22blank+screen%22&type=commits>; <https://news.ycombinator.com/item?id=48555821>

<a name="64-content-omitted"></a>

### 64. Sections or components missing relative to the design

`content-omitted` | tier B | VISUAL.md: not covered (needs a reference; v2 per-app expectations) | injectors: `block-deleted`

- **Renders:** Parts of the intended UI are absent: text under headings, buttons, whole sections; empty bordered regions remain where content should be.
- **Why AI-generated code does it:** [DCGen] found MLLMs omit elements on long pages and that working on smaller segments helps; [WebCompass] finds feature missing the top generation error.
- **How common:** [DCGen] (GPT-4o screenshot-to-code, 1,699 elements on 12 sites): 85.34% omitted, 12.71% misarranged, 2.56% distorted, 40 correct. [WebCompass]: feature missing plus resource failure are about 40 to 55% of generation errors across models. Interaction2Code: missing interactive elements are a critical failure type.
- **Detection (cost: scan):** Needs a reference (a design screenshot or the previous version): match blocks by text and position as Design2Code does. Without a reference, flag sections over 100px tall with a visible background or border and no text, image or control.
- **False-positive traps:** Decorative empty regions; lazy content not loaded yet.
- **Fault injection:** [MAEWU] TreeDelete or ContentDelete: remove a random block or its text.
- **Fix:** Generate in segments; compare with the design before shipping.
- **Sources:** <https://arxiv.org/html/2406.16386v3>; <https://arxiv.org/html/2604.18224v1>; <https://arxiv.org/html/2411.03292v3>; <https://arxiv.org/abs/2403.03163>; <https://people.ece.ubc.ca/amesbah/resources/papers/icsme21.pdf>

<a name="66-duplicate-chrome"></a>

### 66. Two headers, two footers or a repeated section

`duplicate-chrome` | tier B | VISUAL.md: not covered | injectors: `chrome-header-cloned`, `chrome-footer-cloned`, `chrome-section-repeated`, `control-nav-mobile-hidden`, `control-logo-marquee`

- **Renders:** A page shows the navigation bar twice (one under the other, or one fixed and one in the flow), two footers, or a hero or call-to-action block repeated, usually on some routes only.
- **Why AI-generated code does it:** Prompt-by-prompt edits move the header into a layout (App.tsx or layout.tsx) without removing it from each page, or add it to a page that already gets it from the layout. The model edits the file it was pointed at and does not see the other place the component is rendered.
- **How common:**
  - [LovCommits]: 1,504 'fix "duplicate header"', 442 'fix "duplicate footer"', 330 'fix "double header"', 276 'fix "duplicate navbar"'.
  - [Reddit]: an r/lovable post says two headers or footers show up on multiple pages and that it happens constantly; another lists a double header among visual flaws the agent would not fix.
  - [Corpus] re-scan at HEAD: 23 Vite apps render a header or footer in App.tsx outside `<Routes>`, and in 2 of them (9%) pages render the same component again, one app on 12 routes. That is 2 of 377 repos. HEAD snapshots understate the bug, because most duplicates are fixed before the last commit.
  - Tier B on the catalog rule (a measured rate under 10% in AI output, as for `dark-variant-wrong-signal`); the gap review proposed C because the count is small.
- **Detection (cost: pass):** Collect visible header, nav and footer elements, plus [role=banner], [role=navigation] and [role=contentinfo]. For each pair, compare the sets of link texts and hrefs, and report pairs with a Jaccard similarity of 0.8 or more over 3 or more links (or the same logo image src plus the same brand text) that are both visible at the current width and not nested in each other. For repeated sections, hash the normalized text of the top-level children of main and report identical hashes on blocks over 200 characters.
- **False-positive traps:** Responsive pairs: a desktop nav plus a mobile drawer that is display none at this width. Sticky headers cloned for an animation with aria-hidden. A breadcrumb or sub-nav that shares some links. Footer link lists that repeat header links (compare whole sets, not overlap). Carousels with cloned slides for looping. Logo marquees.
- **Fault injection:** Clone the first visible site header with its ids stripped and insert the copy directly after the original (in the flow when the original is fixed or sticky); variants clone the footer and insert the copy before the original, or repeat a top-level block of main. Controls: a copy of the nav that is display none at the test width, and a logo marquee with duplicated items.
- **Fix:** Render site chrome in exactly one layout, remove the per-page copies, and search for every place a Header, Navbar or Footer component is rendered before editing.
- **Sources:** <https://www.reddit.com/r/lovable/comments/1mnm1yc/>; <https://www.reddit.com/r/lovable/comments/1mvqu1i/>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22duplicate+header%22&type=commits>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22duplicate+footer%22&type=commits>

<a name="71-spa-deep-link-404"></a>

### 71. Direct links and page refreshes show the host's 404 page

`spa-deep-link-404` | tier C | VISUAL.md: not covered (the host serves its own page, so neither the app nor GenClass loads and `page-blank` cannot run) | injectors: `spa-deep-link-host-404`, `control-spa-deep-link-ok`, `control-spa-unknown-route`

- **Renders:** The home page works, but a shared link to /pricing or /dashboard, or a refresh on any route, shows the host's 'Page not found' page (Netlify, Vercel, GitHub Pages, S3) instead of the app. Visitors who arrive from search or a shared link see a dead site.
- **Why AI-generated code does it:** Builders generate client-routed apps. The dev server and the builder's own host both fall back to index.html for unknown paths, so the problem stays invisible until the project is exported to a static host, which needs an explicit rewrite: `_redirects`, `netlify.toml`, `vercel.json` rewrites, or a `404.html` redirect.
- **How common:**
  - [Corpus] re-scan: 129 of 184 client-routed apps (70%) ship no app fallback (no `_redirects`, netlify.toml redirect, vercel.json rewrite, 404.html or server fallback). This is exposure only: 125 of the 129 ship no host config at all and presumably run on the builder's host, which handles the fallback. Of the 46 repos that ship a Vercel or Netlify config, 2 lack the rewrite.
  - [Reddit]: about 5 on-topic posts, including one titled 'Lovable Website Shows Page Not Found on Netlify', a launch checklist that warns about a white screen on refresh, and a question about a `_redirects` file that did not work. [LovCommits]: 1,217 'fix "404" refresh'.
  - [SO] 27928372 (React-router URLs don't work when refreshing or writing manually): 925,405 views. Vercel community threads show the rewrite being ignored for Vite apps.
  - Tier C: the measured share is exposure, and where those repos are deployed is unknown.
- **Detection (cost: scan):** The runtime cannot see this, because the host serves its own 404 page and neither the app nor GenClass loads. A harness or crawler collects in-app route hrefs from the home page and requests each one directly as a fresh navigation, not through pushState. It reports when the document status is 404 (PerformanceNavigationTiming.responseStatus in Chromium, or the network response), or 200 with a known host 404 body, and the app root seen on the home page (#root, #\_\_next) is missing.
- **False-positive traps:** Genuinely unknown routes, where a 404 is correct. Routes behind auth that redirect. Static sites with real HTML per page. Preview deployments behind password protection. Hosts that answer with status 404 but still serve the app shell, such as the GitHub Pages 404.html redirect: judge by whether the app root renders, not by the status alone.
- **Fault injection:** Answer the document request for an in-app route other than / with status 404 and a short host-style 'Page Not Found' body that loads none of the app's scripts, then navigate to that route directly. Controls: the same direct navigation answered by the app with status 200, and an unknown path that the app renders as its own NotFound route.
- **Fix:** Add the host's fallback rewrite: Netlify `public/_redirects` with `/* /index.html 200`, Vercel vercel.json rewrites to /index.html, GitHub Pages the 404.html redirect. Add a catch-all NotFound route in the app, or prerender the routes.
- **Sources:** <https://stackoverflow.com/questions/27928372>; <https://www.reddit.com/r/lovable/comments/1k10ug7/>; <https://www.reddit.com/r/lovable/comments/1qy7q92/>; <https://www.reddit.com/r/lovable/comments/1qq7dga/>; <https://www.reddit.com/r/boltnewbuilders/comments/1j5roeh/>; <https://community.vercel.com/t/rewrite-to-index-html-ignored-for-react-vite-spa-404-on-routes/8412>; <https://docs.netlify.com/routing/redirects/rewrites-proxies/#history-pushstate-and-single-page-apps>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22404%22+refresh&type=commits>; <https://www.rapidevelopers.com/md/lovable-issues/fixing-404-errors-on-page-refresh-in-lovable-spas>

<a name="72-stale-chunk-blank"></a>

### 72. After a redeploy, open tabs go blank or show an error on the next navigation

`stale-chunk-blank` | tier C | VISUAL.md: partly `page-blank` (when the failure leaves the main region empty; an error-boundary screen has text) | injectors: `stale-chunk-404`, `control-stale-chunk-recovers`, `control-stale-chunk-eager-route`

- **Renders:** A visitor keeps the site open, the owner publishes a new version, and the visitor then clicks a link to a lazily loaded route. They get a white page or a 'Something went wrong' screen, because the old chunk file name no longer exists on the server. A reload fixes it, so the failure looks random.
- **Why AI-generated code does it:** Generated apps code-split routes with React.lazy(() => import(...)) and are redeployed many times a day from the builder. They do not handle the failed import: no listener for Vite's vite:preloadError event, no reload-once handler, and old assets are not kept.
- **How common:**
  - [Corpus] re-scan: 24 of 235 non-Next repos (10%; Lovable 14, bolt 10) lazy-load routes, and none of the 24 handles vite:preloadError, ChunkLoadError or 'Failed to fetch dynamically imported module'. 20 of the 24 have an error boundary or errorElement, so there the failure shows as an error screen rather than a blank page.
  - vitejs/vite #11804 (TypeError: Failed to fetch dynamically imported module): 236 reactions, 226 comments. [SO] 69300341: 254,885 views; 72376333: 97,541 views. [LovCommits]: 1,269 'fix "dynamically imported module"'. [Reddit]: 1 post.
  - Tier C: 24 repos are 6% of all 377, and the failure needs a redeploy while a tab is open.
- **Detection (cost: events):** Listen for window vite:preloadError, for unhandledrejection and error events whose message matches `/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk \S+ failed/`, and for resource errors on script and link rel=modulepreload. If a `page-blank` state or a visible error-boundary text follows within 2 s, report one finding that names the missing chunk URL and the route being opened.
- **False-positive traps:** Offline or flaky networks (check navigator.onLine and whether other requests failed). Ad blockers that block chunks named with 'ad' or 'track', which Vite's troubleshooting guide mentions. Prefetches that fail but are never used. Dev-server HMR reloads. Apps that already recover by reloading (no lasting blank state).
- **Fault injection:** After a clean load of a lazily routed app, fail every same-origin script request that the clean load did not make (status 404), then click an in-app link to a lazy route. Controls: the same failure on a page with a vite:preloadError handler that reloads once (the page recovers), and a link to a route whose code is in the main bundle.
- **Fix:** Handle the error with `window.addEventListener('vite:preloadError', e => { e.preventDefault(); location.reload(); })`, guarded by a sessionStorage flag so it cannot loop. Keep the previous deploy's assets for a few days, and serve index.html with Cache-Control: no-cache.
- **Sources:** <https://github.com/vitejs/vite/issues/11804>; <https://stackoverflow.com/questions/69300341>; <https://stackoverflow.com/questions/72376333>; <https://vite.dev/guide/build#load-error-handling>; <https://vite.dev/guide/troubleshooting>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22dynamically+imported+module%22&type=commits>

<a name="94-missing-ui-states"></a>

### 94. Missing empty, loading and error states

`missing-ui-states` | tier C | VISUAL.md: not covered | injectors: `api-empty-list`

- **Renders:** Lists and tables render as nothing when data is empty or fails; sections stay blank while loading; buttons look frozen during slow requests.
- **Why AI-generated code does it:** The success path is generated and the edge states are skipped.
- **How common:** OverlayQA (vendor): builders almost never generate empty and error states. A web designer's guide to fixing vibe-coded sites reports missing loading states; a list of 50 common errors in vibe-coded apps includes it. No measured rate.
- **Detection (cost: pass):** Data containers (lists, tables, aria-busy regions) with zero children and near-zero height after network quiet; buttons that start a fetch with no visual or aria-busy change for over 1s.
- **False-positive traps:** Legitimately empty lists that are labelled; lazy sections.
- **Fault injection:** Make the API return [] and render nothing; or delay the response by 3s with no spinner.
- **Fix:** Design empty, loading and error states explicitly.
- **Sources:** <https://overlayqa.com/blog/ai-app-builders-visual-bugs/>; <https://str-webdesign.com/blog/how-to-fix-a-vibe-coded-website-a-web-designers-honest-guide>; <https://blog.vibecoder.me/50-most-common-errors-vibe-coded-apps-fixes>

## Motion and shift

Animation and loading behaviour that hides content, moves it, or makes scrolling hard.

<a name="7-layout-shift"></a>

### 7. Content jumps while loading (unsized media, late content, font swap)

`layout-shift` | tier A | VISUAL.md: v1 `layout-shift` (Chromium only) | injectors: `shift-unsized-image-delayed`, `shift-late-banner`, `shift-font-swap`

- **Renders:** Text and buttons move as images, embeds, fonts or fetched sections arrive; a tap lands on the wrong element. Cards and heroes sit at zero height until the image loads, or for good if it fails.
- **Why AI-generated code does it:** Generated JSX writes `<img src className="w-full">` with no width, height or aspect class. Data-driven sections render only the success state, so they pop in above existing content with no reserved space; skeletons differ in size from the content. Google Fonts are linked without preload or a metric-matched fallback.
- **How common:**
  - [Almanac25]: 62% of mobile and 65% of desktop pages have at least one unsized image; poor CLS on 9% of mobile pages. [Almanac24]: 66% of mobile pages, median 2 per page.
  - [Corpus]: 394 of 2,026 img tags (19%) in 106 of 375 repos (28%) have no width/height and no height, size or aspect class. [Harvv]: images without dimensions on 12% of 85 AI-built sites.
  - [LovCommits]: 1,929 'fix "layout shift"'. [Reddit]: 8 strict-match posts, about 4 on topic.
  - [Almanac25]: 87% of mobile pages use a web font and only 15 to 16% preload fonts.
- **Detection (cost: events):** PerformanceObserver('layout-shift') entries with hadRecentInput false; attribute via sources[].node to the image, late node or text container that moved; window above 0.25 per VISUAL.md. Static corroboration: above-the-fold img, iframe and video without width/height attributes and without CSS aspect-ratio or a fixed height. MutationObserver insertions followed by a shift of later siblings point at late content; shifts aligned with document.fonts loadingdone point at font swap.
- **False-positive traps:** Shifts within 500ms of input; images inside fixed-size or aspect-ratio boxes; below-the-fold images that load before the user scrolls; intended expand animations; ads.
- **Fault injection:** Strip width and height from above-the-fold images and delay their responses by 1 to 2s; or after 1s insert a 200px banner at the top of main with no reserved space; or delay the web font by 2s with font-display swap and a narrow fallback.
- **Fix:** width and height attributes or aspect-ratio on media; reserve min-height for late content; size skeletons like the content; preload fonts and use size-adjust fallbacks (next/font does this).
- **Sources:** <https://almanac.httparchive.org/en/2025/performance>; <https://almanac.httparchive.org/en/2024/performance>; <https://web.dev/articles/optimize-cls>; <https://harvv.com/research/lovable-friction-tax>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22layout+shift%22&type=commits>; <https://www.reddit.com/r/Base44/comments/1rfkv68/>

<a name="13-reduced-motion-ignored"></a>

### 13. Decorative motion that ignores prefers-reduced-motion

`reduced-motion-ignored` | tier A | VISUAL.md: not covered | injectors: `motion-infinite-decoration`

- **Renders:** Floating blobs, pulsing badges and live dots, marquees, parallax and bounce easing keep running for visitors who asked the OS for reduced motion; no pause control on long-running motion.
- **Why AI-generated code does it:** animate-pulse, animate-bounce and Framer Motion loops are added for polish without a motion-safe: variant or a reduced-motion branch.
- **How common:**
  - [DWC]: motion findings on 39% of 123 AI frontends; about one in three ignore the reduced-motion setting.
  - [Almanac24]: prefers-reduced-motion queries on about 50% of sites (34% in 2022). [HN] reviewers describe some vibe-coded layouts as seizure-inducing or flashing.
- **Detection (cost: scan):** Emulate prefers-reduced-motion: reduce, wait 2s, then list document.getAnimations() that are infinite or still advancing currentTime, and CSS animations on elements over 40px that move more than 8px or scale. Flag readable stylesheets that define @keyframes with no reduced-motion media query.
- **False-positive traps:** Essential motion (spinners, progress indicators, video); small opacity or colour transitions under 200ms; user-triggered transitions.
- **Fault injection:** Add an infinite float keyframe (translateY -40px, scale 1.1) on a hero decoration and a 1s infinite pulse on a badge, with no media query; emulate reduced motion.
- **Fix:** Wrap decorative motion in @media (prefers-reduced-motion: no-preference) (Tailwind motion-safe:), stop loops after a few cycles, add a pause control for motion over 5s (WCAG 2.2.2).
- **Sources:** <https://www.designwithclaude.com/design-research/ai-generated-frontends>; <https://almanac.httparchive.org/en/2024/accessibility>; <https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide>; <https://news.ycombinator.com/item?id=48985923>; <https://vibemole.com/resources/avoid-vibecoded-app-design>

<a name="18-content-stuck-invisible"></a>

### 18. Content stuck at opacity 0 from scroll-reveal animations

`content-stuck-invisible` | tier B | VISUAL.md: held back (VISUAL.md section 4: report-only first) | injectors: `reveal-never-fires`, `reveal-threshold-unreachable`, `control-reveal-completes`

- **Renders:** Sections, headings or the hero render at opacity 0 or translated away until an IntersectionObserver or whileInView fires. When it fires late, never fires (threshold 1 on an element taller than the viewport, amount 'all', wrong scroll root, client navigation that does not re-trigger), or JS fails, the content stays blank: large empty gaps, blank screenshots and link previews, delayed LCP.
- **Why AI-generated code does it:** initial={{opacity:0, y:20}} with whileInView on every section, including above the fold, is the default premium-feel move in generated landing pages; server rendering bakes opacity 0 into inline styles.
- **How common:**
  - [Corpus]: initial opacity 0 in 107 of 375 repos (29%); whileInView in 49 (13%); viewport amount 0.5 or more in 23 (6%).
  - [DWC]: motion findings on 39% of 123 AI frontends. A dev.to case: the heading stayed at opacity 0 until hydration, mobile LCP over 6s. Shopify guidance: Chrome does not consider opacity 0 elements for LCP; removing hero fades gave 3 to 6s LCP gains in their examples. motion issue 3079: whileInView not triggered on soft navigation; PR 3639 (2026) fixes a remount case.
  - [HN] reviewers name fade-in-and-slide-up on scroll as an AI tell; the YC review lists automatic fade-ins.
- **Detection (cost: pass):** After the settle gates, in a visible tab, scroll each section into view, wait 1.5s and for document.getAnimations() to finish; flag text-bearing elements (20+ characters) intersecting the viewport whose effective opacity (product over ancestors) is under 0.05 or whose transform keeps them off screen, or with aos-init but no aos-animate. Compute the reachable intersection ratio min(1, innerHeight / rect.height) and compare it with declared thresholds. In the harness, also render with JS disabled and count text with inline opacity 0.
- **False-positive traps:** Hidden-tab throttling (IntersectionObserver and rAF pause): never measure there. Inactive carousel slides, tab panels, closed menus and dialogs, aria-hidden, skeletons. Elements still animating. A checker that never scrolls.
- **Fault injection:** Set style opacity:0;transform:translateY(40px) on a content section and never remove it; realistic variant: an IntersectionObserver with threshold 1.0 that reveals a section taller than the viewport.
- **Fix:** Render visible by default and add the hidden state from JS only for below-the-fold elements; never animate the LCP element; small amounts (0.1 or 'some'); jump to the final state under reduced motion.
- **Sources:** <https://dev.to/gillygangopolus/the-scroll-animation-that-was-hiding-our-lcp-element-2edp>; <https://shopify.dev/docs/storefronts/themes/best-practices/performance/dont-hide-lcp-image-behind-animations>; <https://github.com/motiondivision/motion/issues/3079>; <https://github.com/motiondivision/motion/pull/3639>; <https://motion.dev/docs/react-motion-component>; <https://www.designwithclaude.com/design-research/ai-generated-frontends>; <https://news.ycombinator.com/item?id=45551558>

<a name="19-route-scroll-kept"></a>

### 19. A new route opens at the previous page's scroll position

`route-scroll-kept` | tier B | VISUAL.md: not covered | injectors: `route-scroll-kept-wrapped`, `control-route-scroll-reset`, `control-route-hash-link`

- **Renders:** In client-routed single-page apps, a click on a link near the bottom of a page (footer links to Privacy, Terms or Contact, or the last card in a list) opens the next page already scrolled to its middle or footer. The visitor sees the end of the new page or blank space and can take the page for empty. A Lovable user describes a smooth-scroll variant in which the old page visibly scrolls up before the new page appears.
- **Why AI-generated code does it:** Lovable and bolt.new generate Vite and React Router apps with BrowserRouter. BrowserRouter keeps the window scroll position across pushState navigations, so a reset needs a ScrollToTop component or the data router's ScrollRestoration, and the templates include neither. The Next.js App Router (v0) resets scroll by itself, which is why v0 barely appears in the count.
- **How common:**
  - [Corpus] re-scan: 144 of 184 client-routed apps (78%; Lovable 111 of 142, bolt 32 of 41) contain no scroll reset at all (no ScrollRestoration, ScrollToTop, scrollTo(0, 0), scrollTo({top: 0}) or scrollTop = 0), 38% of all 377 repos. 100 of the 144 have 3 or more routes and 3 or more in-app links.
  - [LovCommits] (REST search API): 3,593 'fix "scroll to top"', 1,570 'fix "scroll position"', 1,235 'fix ScrollToTop'.
  - [SO] 36904185 (react-router scroll to top on every transition): 311,523 views. react-router #3950 (scroll management): 30 reactions. [Reddit]: one r/lovable post about credits spent on the scroll behaviour during navigation; strict regexes found few posts.
  - Tier B: the source pattern is in 10% or more of repos and fails when a visitor navigates from a scrolled position.
- **Detection (cost: events):** Patch history.pushState and replaceState and listen to popstate. On a pushState that changes the pathname, record scrollY before the change; skip hash-only and search-only changes, and skip popstate, where restoring the old position is correct. After the route settles (main-content mutations quiet for 300 ms plus two frames, behind the VISUAL.md 2.3 gates), report when scrollY is still above 0.5 x innerHeight and the main heading or main landmark text has changed. Name the clicked link. When the window does not scroll, repeat the check on the app's main scroll container (the largest element with overflow-y auto).
- **False-positive traps:** Intentional scroll preservation: infinite feeds, tabs or filters implemented as routes, modal routes over a list. Links with a #anchor or a ?section parameter that scroll to a section on purpose. Back and forward navigation. Apps that restore scroll asynchronously after data loads (wait for settle). Very short pages, where the old scrollY cannot be kept anyway.
- **Fault injection:** On a client-routed app that resets scroll correctly, set history.scrollRestoration to manual and wrap window.scrollTo, window.scroll, Element.prototype.scrollTo, Element.prototype.scrollIntoView and the scrollTop setter of document.scrollingElement so that calls are ignored for 1 s after any pushState; scroll to 80% of the document height and click an in-app link to another route. Controls: the same navigation without the wrappers (the app resets to the top), and a same-page hash link, where the position change is intended.
- **Fix:** Render a ScrollToTop component inside the router: a useLayoutEffect keyed on pathname that calls window.scrollTo({ top: 0, behavior: 'instant' }), skipped when the URL has a hash. Or move to createBrowserRouter and render `<ScrollRestoration />`.
- **Sources:** <https://stackoverflow.com/questions/36904185>; <https://github.com/remix-run/react-router/issues/3950>; <https://reactrouter.com/api/components/ScrollRestoration>; <https://www.reddit.com/r/lovable/comments/1nr4762/>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22scroll+to+top%22&type=commits>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22scroll+position%22&type=commits>; <https://dev.to/kingjames_x/how-to-fix-react-routers-scroll-position-on-page-transitions-7cb>

<a name="73-scrollbar-shift"></a>

### 73. Scroll lock side effects: the page jumps sideways, or the page behind scrolls

`scrollbar-shift` | tier C | VISUAL.md: not covered | injectors: `scroll-lock-no-gutter`

- **Renders:** Opening a Select, DropdownMenu, Dialog, Sheet or Drawer hides the page scrollbar and content and fixed headers jump sideways by its width, gain double padding with scrollbar-gutter stable, or show a white strip next to backdrop-blur headers; or scrolling past the end of a modal scrolls the page behind it.
- **Why AI-generated code does it:** Modal menus and selects by default; body overflow hidden without gutter compensation; fixed headers without the compensation class; no overscroll-behavior on modal scrollers. Invisible on macOS overlay scrollbars.
- **How common:** shadcn-ui #4227 (Select removes scrollbar) 31 reactions; #4321. radix #1925 (65 comments), #3251. headlessui #839 (14 reactions), #1319, #3812 (white strip with v4 and backdrop-blur). [LovCommits]: 6,366 'fix scrollbar'. Stack Overflow 1417934 (scrollbar repositions page) about 256k views, 9280258 (prevent body scroll but allow overlay scroll) about 1.16M. [HN]: a reviewer bothered by scrollbar presence pushing the page left and right.
- **Detection (cost: scan):** With classic scrollbars forced, record rects of fixed or sticky headers and main content, open an overlay (or watch for body data-scroll-locked or overflow hidden), and report x or width shifts over 1px; for chaining, dispatch a wheel at the end of the modal scroller and check whether window.scrollY changes.
- **False-positive traps:** Overlay scrollbars never show the shift (false negatives); non-modal menus; must run with classic scrollbars.
- **Fault injection:** On overlay open set document.body.style.overflow='hidden' without padding compensation on a scrolling page with ::-webkit-scrollbar{width:16px}; remove overscroll-behavior from a modal body.
- **Fix:** scrollbar-gutter stable on html with libraries told not to pad, or compensation on fixed elements; modal={false} for menus and selects; overscroll-behavior contain.
- **Sources:** <https://github.com/shadcn-ui/ui/issues/4227>; <https://github.com/radix-ui/primitives/issues/1925>; <https://github.com/tailwindlabs/headlessui/issues/3812>; <https://stackoverflow.com/questions/1417934>; <https://stackoverflow.com/questions/9280258>; <https://news.ycombinator.com/item?id=49756971>

<a name="77-fouc-late-css"></a>

### 77. Flash of unstyled content from late CSS (client navigation, Play CDN)

`fouc-late-css` | tier C | VISUAL.md: not covered | injectors: `css-late-reinsert`

- **Renders:** During route changes or slow CSS loads, content paints briefly with browser defaults and then snaps into place; with the Tailwind Play CDN script, styles are generated after the HTML paints.
- **Why AI-generated code does it:** next/dynamic and lazy components with co-located CSS above the fold; route-level CSS modules removed early; single-file outputs using `<script src="https://cdn.tailwindcss.com">` in production.
- **How common:** vercel/next.js #17464 (CSS modules removed too early on route change) 281 reactions, 107 comments; #18769 (38 reactions), #11195, #77239, #62940; 50 next.js issues titled FOUC. Tailwind docs: the Play CDN is for development only; the v3.0 alpha notes say its MutationObserver cannot avoid FOUC.
- **Detection (cost: scan):** layout-shift entries after FCP that coincide with stylesheet load events; elements whose computed styles change substantially after a link or style insertion; sample new content around navigations for UA defaults for a frame; script[src\*='cdn.tailwindcss.com'] or @tailwindcss/browser present.
- **False-positive traps:** Dev-mode FOUC (Next dev injects CSS by JS) that production does not have; prototypes and demos.
- **Fault injection:** Detach the page stylesheet at load and re-insert it 500ms later; or on route change remove it one frame before new content mounts.
- **Fix:** Import above-the-fold CSS in layouts; avoid CSS in lazy chunks for initial content; a CLI or PostCSS build instead of the Play CDN.
- **Sources:** <https://github.com/vercel/next.js/issues/17464>; <https://github.com/vercel/next.js/issues/18769>; <https://github.com/vercel/next.js/issues/77239>; <https://tailwindcss.com/docs/installation/play-cdn>; <https://github.com/tailwindlabs/tailwindcss/releases/tag/v3.0.0-alpha.1>

<a name="82-scroll-jank"></a>

### 82. Laggy scrolling from stacked blur, glow blobs, animated backgrounds and layout animations

`scroll-jank` | tier C | VISUAL.md: not covered | injectors: `jank-blur-stack`, `jank-layout-animation`

- **Renders:** Scrolling stutters, fans spin and low-end phones drop frames; entrance and hover animations on width, height, top, margin or box-shadow shift surrounding content.
- **Why AI-generated code does it:** Many backdrop-filter blur panels, huge filter blur gradient blobs with infinite animations, particle canvases running off screen, background-attachment fixed, and animations on non-composited properties are added for a premium feel.
- **How common:** [HN]: several reviewers say the scroll of vibe-coded apps is laggy in the same way, or that animated backgrounds slow their PC. [Krebs] scores glassmorphism and large coloured glows. [Almanac25]: non-composited animations on 40% of mobile and 44% of desktop pages.
- **Detection (cost: scan):** Sum the area of visible backdrop-filter blur elements (flag over about 2x the viewport, or 6 or more panels); find filter blur(40px or more) elements over 30% of the viewport with running animations; list document.getAnimations() whose keyframes target filter, box-shadow, width, height, top, left or margin; during a scripted scroll record long-animation-frame or rAF intervals over 50ms; flag canvas rAF loops that run while the canvas is off screen.
- **False-positive traps:** Headless Chromium with software GL exaggerates cost (calibrate on GPU runs or use relative thresholds); WebGL apps and games; a single blurred sticky nav; user-triggered accordions.
- **Fault injection:** Add a fixed full-viewport layer with a radial gradient, filter:blur(80px) and an infinite 6s animation of transform and filter; give 10 cards backdrop-filter:blur(24px); replace a transform entrance with @keyframes in{from{margin-top:40px}}.
- **Fix:** Limit blur to one or two small surfaces, use static images for glows, animate only transform and opacity, pause canvases off screen and under reduced motion.
- **Sources:** <https://news.ycombinator.com/item?id=49632290>; <https://news.ycombinator.com/item?id=48205820>; <https://news.ycombinator.com/item?id=49151816>; <https://www.adriankrebs.ch/blog/design-slop/>; <https://almanac.httparchive.org/en/2025/performance>

<a name="83-scroll-hijack"></a>

### 83. Scroll hijacking, pinned sections and scroll-snap traps

`scroll-hijack` | tier C | VISUAL.md: not covered | injectors: `scroll-snap-trap`, `wheel-hijack`

- **Renders:** The wheel or swipe no longer moves the page normally: sections pin while content animates, horizontal scroll replaces vertical, smooth-scroll libraries add inertia, or mandatory scroll-snap with sections taller than the viewport makes content unreachable.
- **Why AI-generated code does it:** Apple-style storytelling prompts lead to GSAP ScrollTrigger pin and scrub, Lenis, or html{scroll-snap-type:y mandatory} with h-screen sections.
- **How common:** Search Engine Journal's summary of a Y Combinator review of vibe-coded sites says scroll hijacking was the most frequent issue the reviewers hit. [HN] comments list carousels and scroll hijacking as tells. unslop-ui counts scrolljacking within excessive animation (1.1% of comments). [Corpus] re-scan: 8 of 377 repos (2%; Lovable 4, bolt 4, v0 0) ship Lenis, Locomotive Scroll, fullPage.js, GSAP pin: true or y-mandatory scroll snap, so the review's most frequent issue does not show up as a common pattern in builder repos; tier C stands.
- **Detection (cost: scan):** Dispatch a 400px wheel gesture and compare the scrollY change with the expected amount (under 50% or over 150%, or stuck); detect non-passive wheel or touchmove listeners on window, document or body that call preventDefault; html with a lenis class or GSAP pin-spacer elements; with root scroll-snap-type y mandatory, snap children taller than the viewport with overflow hidden.
- **False-positive traps:** Maps, editors, canvases and carousels that capture the wheel inside their bounds; scroll-snap proximity in galleries; short pinned sections.
- **Fault injection:** Add html{scroll-snap-type:y mandatory} section{scroll-snap-align:start;height:100vh;overflow:hidden} to a page whose sections are taller than the viewport; or a non-passive window wheel listener that calls preventDefault and moves a transform at 30% speed.
- **Fix:** Native scrolling; keep pinning short and skippable; disable it on touch and under reduced motion.
- **Sources:** <https://www.searchenginejournal.com/7-common-ai-website-mistakes-that-are-easy-to-avoid/574196/>; <https://www.youtube.com/watch?v=DNSXlBmukck>; <https://news.ycombinator.com/item?id=49867038>; <https://skillsmp.com/creators/iamneilroberts/claude-skills/skills-unslop-ui>; <https://github.com/darkroomengineering/lenis>

<a name="96-js-breakpoint-flash"></a>

### 96. Layout chosen by a JS breakpoint hook (desktop layout flashes on phones)

`js-breakpoint-flash` | tier C | VISUAL.md: not covered | injectors: `late-mobile-swap`

- **Renders:** The first paint on a phone shows the desktop sidebar or nav, which swaps to the mobile layout after hydration and shifts the page.
- **Why AI-generated code does it:** shadcn hooks/use-mobile.ts starts at undefined, sets the value in useEffect and returns !!isMobile, so the server and first client render report desktop.
- **How common:** 21 shadcn issues mention useIsMobile; the hook ships with the shadcn sidebar used in generated dashboards. The flash is inferred from the code.
- **Detection (cost: scan):** Under mobile emulation, large layout-shift entries in the first second plus DOM mutations after hydration that replace header or sidebar structure.
- **False-positive traps:** Client-only widgets with reserved placeholders.
- **Fault injection:** Render desktop sidebar markup at first paint and switch to the mobile sheet in setTimeout(..., 200) on narrow viewports.
- **Fix:** CSS media queries; render both variants and toggle visibility with CSS.
- **Sources:** <https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/hooks/use-mobile.ts>

<a name="108-stat-counter-zero"></a>

### 108. Animated stat counters frozen at 0

`stat-counter-zero` | tier D | VISUAL.md: not covered | injectors: `stat-zero`

- **Renders:** Stat banners (10,000+ users, 99.9% uptime) start at 0 and count up when an observer fires; in screenshots, crawlers, reduced motion or when the observer never fires they read 0+ or 0%.
- **Why AI-generated code does it:** Stat banner rows are a stock AI landing section and count-up scripts start from a hard-coded 0 in the HTML.
- **How common:** The stat banner is common ([Krebs] scores it; design-slop-cop has a detector); the frozen-at-0 failure is mechanism only, from counter tutorials that wait for an IntersectionObserver. [Corpus] re-scan: 15 of 377 repos (4%) ship an animated counter (react-countup, CountUp, a count-up hook or animateValue). This is exposure only: the counter fails only when the observer never fires (hidden tab, element already in view at load, a reduced-motion path that skips the animation). Tier D stands; a render pass that confirms failures would move it to C.
- **Detection (cost: pass):** Stat-like elements (24px or larger, numeric text under 15 characters, three or more siblings); after scrolling into view and 3s, text still matching `^0([.,]0+)?\s*(\+|%|k|K|x|M)?$`; server HTML with only zeros in those nodes.
- **False-positive traps:** Genuine zero values; counters still animating (wait for two stable reads).
- **Fault injection:** Replace each stat number's text with 0+ and disable the counting script.
- **Fix:** Render the final value in HTML and animate from 0 only when JS runs; set it immediately under reduced motion.
- **Sources:** <https://www.adriankrebs.ch/blog/design-slop/>; <https://github.com/AdrianKrebs/design-slop-cop>; <https://github.com/glennreyes/react-countup>

<a name="109-exit-animation-skipped"></a>

### 109. Exit animations skipped or overlapping (AnimatePresence)

`exit-animation-skipped` | tier D | VISUAL.md: not covered | injectors: `route-double-render`

- **Renders:** Modals and route transitions vanish instantly, or the old and new page render together briefly and the layout jumps; unstable keys cause blinking.
- **Why AI-generated code does it:** Conditionals placed around AnimatePresence, index keys, AnimatePresence inside a page component that unmounts.
- **How common:** 59 motion issues titled AnimatePresence exit (#493, #2416 13 reactions, #3803 in 2026); the motion docs list placement and key rules.
- **Detection (cost: scan):** During route changes, count main landmarks or page containers visible at once and record layout-shift spikes; report-only.
- **False-positive traps:** Cross-fade designs where overlap is intended.
- **Fault injection:** Keep the previous page container in normal flow beside the new one for 400ms on navigation.
- **Fix:** Conditional inside AnimatePresence, stable keys, AnimatePresence in a persistent layout, mode wait or popLayout.
- **Sources:** <https://github.com/motiondivision/motion/issues/493>; <https://github.com/motiondivision/motion/issues/2416>; <https://motion.dev/docs/react-animate-presence>

## Dark mode

Bugs that appear only in one colour scheme or while the theme is being applied.

<a name="16-dark-mode-partial"></a>

### 16. Half-applied dark mode (surfaces and text flip separately)

`dark-mode-partial` | tier B | VISUAL.md: v1 `text-invisible` catches the under 1.5:1 cases in scan mode (both schemes) | injectors: `dark-card-hardcoded-white`, `dark-input-low`, `control-dark-brand-section`

- **Renders:** In dark mode some cards stay white while their text turns light (white on white), dark text sits on dark panels, inputs show dark grey text on a dark grey field, sidebars and dropdown items become unreadable, charts, borders, shadows and skeletons vanish, and iframes stay light. A toggle can appear to do nothing.
- **Why AI-generated code does it:** Across prompt sessions models mix hard-coded colours (bg-white, text-black, #fff, fill="#000") with theme tokens (bg-background, text-foreground), and add dark: variants to some components only. The create-next-app globals.css flips --foreground under prefers-color-scheme while generated components assume a light page. Dark mode is often added late.
- **How common:**
  - [SUD] (308 setting-triggered Android display bugs, not AI-specific): dark mode is the largest trigger, 111 bugs (36%), and colour inconsistency the largest symptom.
  - [Corpus]: dark: utilities in 85% of repos. The first sweep's class-based toggle in 81% counted next-themes imports; the gap review's re-scan found that 160 of the 291 repos importing next-themes use it only in shadcn's components/ui/sonner.tsx, and that 113 of 377 repos (30%) change the theme from their own code (setTheme, toggleTheme, a dark class toggle, data-theme or a stored theme key). Those 30%, plus apps whose dark: classes follow the OS setting, are the exposed share. [LovCommits]: 14,990 'fix "dark mode"', 5,471 'fix "light mode"', 3,065 'fix "white text"'.
  - [Reddit]: 7 strict-match posts, all verified (one user asked the builder 20+ times; a SwiftUI scan of one AI-built app found 485 issues, mostly hard-coded colours). [HN] Show HN: 10 comments, including one measuring the same oklch background in both modes. XDA's review found Lovable used a sidebar font colour that made navigation invisible.
- **Detection (cost: scan):** Render with emulated prefers-color-scheme light and dark, and with the app's own toggle (html.dark or data-theme) when present. Run the contrast check in each state; flag elements that pass in one state and fail in the other, and anything under 1.5:1 as invisible. Report large light surfaces (luminance over 0.8) on a dark page (under 0.2) only as low-severity unthemed surfaces. Flag a toggle click that changes no computed colour.
- **False-positive traps:** Single-theme sites look the same in both renders, which is fine. Intentionally theme-invariant elements: code previews, maps, images, brand banners, third-party iframes, a dark footer on a light page.
- **Fault injection:** Under dark mode, set one card to background #fff while its text inherits the light foreground; or set inputs to background #27272a with color #3f3f46.
- **Fix:** Route every colour through semantic tokens defined for both themes (bg-card with text-card-foreground); lint against raw bg-white and text-black; test both schemes; remove the template prefers-color-scheme block if the app has no dark mode.
- **Sources:** <https://arxiv.org/html/2607.04120v1>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+%22dark+mode%22&type=commits>; <https://www.reddit.com/r/lovable/comments/1jjas7f/>; <https://www.reddit.com/r/vibecoding/comments/1prtvp9/>; <https://news.ycombinator.com/item?id=46266801>; <https://news.ycombinator.com/item?id=47864393>; <https://www.xda-developers.com/tried-vibe-coding-a-real-app-in-bolt-v0-and-lovable/>; <https://github.com/vercel/next.js/discussions/40866>; <https://www.indiehackers.com/post/i-finally-added-dark-mode-and-it-forced-me-to-fix-more-than-colors-23df60ead5>

<a name="27-theme-flash"></a>

### 27. Wrong theme painted first (white flash) and theme UI wrong after hydration

`theme-flash` | tier B | VISUAL.md: not covered | injectors: `theme-late-class`, `theme-script-removed-stored`, `control-theme-script-kept`

- **Renders:** Dark-mode visitors see a white page (or the wrong theme) on load or navigation before JS applies the saved theme; theme toggles show the server's icon (sun while dark); hydration errors on html class force a re-render with visible flicker.
- **Why AI-generated code does it:** Theme read from localStorage in useEffect or a ThemeProvider after first paint instead of a blocking head script (the generated index.html of client-rendered Vite apps has none); ThemeProvider without suppressHydrationWarning; reading the theme during render without a mounted guard.
- **How common:**
  - [Corpus] re-scan: 113 of 377 repos (30%) change the theme from their own code (setTheme, toggleTheme, classList add or toggle 'dark', data-theme, or a stored theme key). 60 of those are client-rendered apps, and none of the 60 has an inline script in index.html that applies the stored theme before first paint. That is 16% of all repos, and the defect hits every visitor with a stored preference, so the entry moved from tier C to tier B in the gap review (a source pattern in 10% or more of repos that fails under a condition).
  - next-themes #343 (white flash on 0.4.5, still on 0.4.6) 32 reactions; #281, #169 (14 reactions), #316; 24 next-themes issues titled with flash. shadcn #5552 (ThemeProvider hydration error in Next 15) 99 reactions. Code search: 2,180 v0 app/layout.tsx files use ThemeProvider and 1,948 have suppressHydrationWarning (about 11% without). [LovCommits]: 7,415 'fix flash', 6,333 'fix flicker'. [HN]: UI rendering in flashes of white named as a vibe-coded tell.
- **Detection (cost: scan):** Inject a document-start script (CDP Page.addScriptToEvaluateOnNewDocument) with a MutationObserver on html and body class and style plus paint timing; with a stored dark preference (set localStorage before load) or OS dark emulation, report a root theme class or a background luminance swing over 0.5 after first-contentful-paint. Compare a toggle's aria-label or icon with the resolved theme; capture hydration errors. A cheap events check in the page: read documentElement.className and data-theme at DOMContentLoaded and again after the settle gates; when a theme key exists in localStorage, the value differs between the two reads, and the body background luminance changed by more than 0.5, report a theme flash.
- **False-positive traps:** Splash screens; animated theme transitions; user-triggered toggles; light-only sites; dev-only hydration warnings; apps whose default matches the stored value; Next.js apps where next-themes injects its script into the server HTML.
- **Fault injection:** Remove the inline theme script and add the dark class in setTimeout(..., 300 to 600) after load; or, on a Vite app with a working inline theme script, remove the script and store the non-default theme before navigation so the app's own provider applies it late. Control: the same stored theme with the inline script kept.
- **Fix:** A blocking inline head script that sets the class before body renders (next-themes), suppressHydrationWarning on html, a mounted guard for theme-dependent UI, a color-scheme meta and the background on html.
- **Sources:** <https://github.com/pacocoursey/next-themes/issues/343>; <https://github.com/pacocoursey/next-themes/issues/281>; <https://github.com/pacocoursey/next-themes/issues/169>; <https://github.com/shadcn-ui/ui/issues/5552>; <https://news.ycombinator.com/item?id=46648765>; <https://codefronts.com/design-styles/tailwind-css-dark-mode-ui/fix-tailwind-dark-mode-flash-fouc-head-script/>; <https://ui.shadcn.com/docs/dark-mode/vite>; <https://github.com/search?q=author-name%3Agpt-engineer-app%5Bbot%5D+fix+flash&type=commits>

<a name="50-color-scheme-missing"></a>

### 50. Dark UI without color-scheme (light native controls, scrollbars and overscroll)

`color-scheme-missing` | tier B | VISUAL.md: not covered | injectors: `color-scheme-light-on-dark`

- **Renders:** In a dark UI, select menus, date pickers, scrollbars, checkboxes and autofilled fields render light, sometimes with light text on white options; white bands show on overscroll or before CSS loads when the background is set on body only.
- **Why AI-generated code does it:** Dark themes are built from classes or variables only; color-scheme is never set; selects are styled bg-transparent (Firefox and Windows draw the popup from the select background).
- **How common:**
  - [Corpus]: 24% of repos mention color-scheme anywhere. The gap review's re-scan found that 113 of 377 repos (30%) change the theme from their own code; the 81% toggle figure from the first sweep counted next-themes imports, most of them only in shadcn's sonner.tsx. Web Almanac 2022 CSS: color-scheme on 0.2% of pages.
  - Firefox bug 1825958 (WONTFIX: popup palette follows the select background); tailwindcss discussion #18730; Stack Overflow 2781549 (autofill background) about 948k views.
- **Detection (cost: pass):** When the effective page background luminance is under 0.2, read getComputedStyle(document.documentElement).colorScheme; flag 'normal' or 'light' when native selects, date inputs or scroll containers exist; flag select with a transparent background in a dark theme; flag html background differing from body background on a dark page.
- **False-positive traps:** Fully custom controls and scrollbars; light pages with dark sections.
- **Fault injection:** On a dark page set html{color-scheme:light} and select{background:transparent}, with a native select and a long scroll container.
- **Fix:** :root{color-scheme: light dark} or color-scheme: dark under .dark; set the background on html; explicit option colours.
- **Sources:** <https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme>; <https://web.dev/articles/color-scheme>; <https://almanac.httparchive.org/en/2022/css>; <https://bugzilla.mozilla.org/show_bug.cgi?id=1825958>; <https://github.com/tailwindlabs/tailwindcss/discussions/18730>; <https://stackoverflow.com/questions/2781549>

<a name="65-dark-variant-wrong-signal"></a>

### 65. Tailwind v4 dark: variant follows the OS while the app toggles a class

`dark-variant-wrong-signal` | tier B | VISUAL.md: not covered | injectors: `dark-variant-media-only`

- **Renders:** The toggle flips the CSS-variable colours under .dark, but dark: utilities still follow prefers-color-scheme: half the page light and half dark, white cards with white text, or a toggle that seems to do nothing for utility-styled parts.
- **Why AI-generated code does it:** In v4 the dark variant compiles to @media (prefers-color-scheme: dark) unless @custom-variant dark (&:where(.dark, .dark \*)) is declared; models trained on v3 darkMode: 'class' config omit it.
- **How common:** [Corpus]: 2 of 42 v4 repos have dark: utilities plus a class toggle and no @custom-variant (small because most v4 repos come from v0 templates that include it). The compiled v4.1.14 output confirms the media query default. 16 tailwindcss discussions with dark mode and v4 in the title (#18207, #18203); 21st.dev lists dark mode not activating.
- **Detection (cost: scan):** Render with emulated prefers-color-scheme light plus html.dark set, then dark with no .dark class; elements carrying dark: classes that respond to the media emulation and not to the class (or the reverse) mean the variant is bound to the wrong signal; pair with the contrast check.
- **False-positive traps:** Apps that intentionally follow only the OS; pages with no toggle; system mode where both agree.
- **Fault injection:** On a class-toggled v4 page, rewrite the dark rules to sit only under @media (prefers-color-scheme: dark), then add class dark to html with the OS scheme light.
- **Fix:** @custom-variant dark (&:where(.dark, .dark \*)); after @import "tailwindcss".
- **Sources:** <https://tailwindcss.com/docs/dark-mode>; <https://github.com/tailwindlabs/tailwindcss/discussions/18207>; <https://github.com/tailwindlabs/tailwindcss/discussions/18203>; <https://21st.dev/blog/tailwind-css-ui-mistakes>

<a name="105-prose-unthemed"></a>

### 105. Tailwind prose left in light colours on a dark page

`prose-unthemed` | tier D | VISUAL.md: v1 `text-invisible` only below 1.5:1 | injectors: `prose-dark-uninverted`

- **Renders:** Markdown or blog content in .prose keeps the plugin's dark-grey body text on a near-black page; one HN thread measured about 2:1.
- **Why AI-generated code does it:** class="prose" added for rendered markdown without dark:prose-invert (or prose-invert on dark-only sites).
- **How common:** One HN thread, where the site author confirmed Tailwind prose caused it; plausibly common wherever AI sites render markdown.
- **Detection (cost: pass):** Elements with class prose and no prose-invert whose effective background luminance is under 0.2 and whose descendant p or li contrast is under 4.5:1 (the general contrast check catches it; this names the cause).
- **False-positive traps:** A prose block inside a light card on a dark page; prose-invert through a parent variant; overridden --tw-prose-\* variables.
- **Fault injection:** Inside a #0a0a0a section, wrap article text in .prose with .prose{color:#364153} .prose h2{color:#101828}.
- **Fix:** dark:prose-invert, or map the --tw-prose-body variables to theme tokens.
- **Sources:** <https://news.ycombinator.com/item?id=46266801>; <https://news.ycombinator.com/item?id=46289191>

## Responsive

Bugs that appear only at some widths, devices, text sizes or writing directions.

<a name="3-viewport-meta-missing"></a>

### 3. Missing or wrong viewport meta (desktop page shrunk onto the phone)

`viewport-meta-missing` | tier A | VISUAL.md: v1 `viewport-meta-missing` | injectors: `viewport-meta-remove`, `viewport-meta-fixed-width`

- **Renders:** Phones lay the page out at about 980px and scale it down: tiny text and buttons, sm:/md: breakpoints never fire. A fixed width (width=1024) or initial-scale other than 1 cuts content off or fills only part of the screen.
- **Why AI-generated code does it:** Single-file HTML outputs and some scaffolds omit the head tag; agents edit body content and never touch head; desktop previews hide the problem.
- **How common:**
  - [XCompat]: the most common root cause, on 64 of 139 failing AI pages (46.0%), which is about 32% of all 203 AI pages (computed). Symptoms: shrink-to-fit in 42.1% and initial-scale mismatch in 23.1% of failing pairs. AI pages failed across devices far more often than across browsers (67.5% vs 1.0%).
  - [Harvv] lists missing viewport tags among recurring Lovable problems. A Bolt user reports a phone showing the desktop version while the emulator looked right.
- **Detection (cost: events):** Parse meta[name=viewport]: absent, width other than device-width, or initial-scale other than 1. Confirm under mobile emulation: documentElement.clientWidth near 980 while screen.width is under 500, or visualViewport.scale < 1 at load. Report once per page.
- **False-positive traps:** Meta tag added by script after load (re-check after load). Documents in iframes ignore viewport meta. Desktop-only internal tools on purpose. WebViews that inject their own viewport. Only meaningful under a mobile profile.
- **Fault injection:** Remove meta[name=viewport] from the HTML response before parse (route interception), or rewrite its content to width=1024. Removing it after load does not re-layout in every engine.
- **Fix:** <meta name="viewport" content="width=device-width, initial-scale=1">.
- **Sources:** <https://arxiv.org/html/2608.12518v1>; <https://harvv.com/research/lovable-friction-tax>; <https://www.reddit.com/r/boltnewbuilders/comments/1iwqrgv/>; <https://www.rapidevelopers.com/md/lovable-issues/fixing-layout-issues-in-lovable-on-mobile-devices>

<a name="4-layout-not-adapted"></a>

### 4. Desktop layout kept on phones (rows that never wrap, fixed columns, fixed sidebars)

`layout-not-adapted` | tier A | VISUAL.md: not covered (scan mode: needs a second width) | injectors: `layout-grid-fixed-columns`, `layout-fixed-sidebar`

- **Renders:** At 375px three or four columns stay side by side, flex rows of cards or buttons stay on one line, or a fixed w-64 sidebar takes half the screen. Columns shrink to about 90px and wrap one word per line, or push content off screen.
- **Why AI-generated code does it:** Models write grid-cols-3 and flex-row without a mobile base (grid-cols-1 md:grid-cols-3), or misread sm: as small screens only. Mobile is added later by prompt and regresses on each regeneration.
- **How common:**
  - [XCompat]: missing flex or grid wrapping is the root cause on 41 of 139 failing AI pages (29.5%), the second most common; flex appears in 95.1% of generated pages.
  - [Reddit]: 27 strict-match posts and about 30 verified by reading (Lovable 10, vibecoding 10), including a list of recurring problems that puts fine on desktop, bad on mobile first. [HN] Show HN: 29 comments say a launch is broken, unreadable or cut off on mobile.
  - Agency guides for Lovable call it the most common layout issue.
- **Detection (cost: scan):** Render at 1280 and 375px. Flag flex or grid rows with 2 or more children holding paragraph text where any child is under 120px wide, or the average words per rendered line (Range.getClientRects line count against word count) is under 3. Flag content grids whose column count is the same at both widths. Flag flex containers with flex-wrap nowrap whose scrollWidth > clientWidth + 1.
- **False-positive traps:** Icon toolbars and stat rows with short labels legitimately stay in one row. Data tables in scroll wrappers. Tab strips designed to scroll. Apps that say they are desktop-only.
- **Fault injection:** Force a card grid to grid-template-columns repeat(3, 1fr) at all widths, or wrap main content in a flex row whose first child is a 256px fixed sidebar.
- **Fix:** Mobile-first: grid-cols-1 sm:grid-cols-2 lg:grid-cols-3, flex-col md:flex-row, flex-wrap with gap, hide or overlay the sidebar below md.
- **Sources:** <https://arxiv.org/html/2608.12518v1>; <https://www.reddit.com/r/vibecoding/comments/1n785mi/>; <https://www.reddit.com/r/lovable/comments/1n19lhf/>; <https://news.ycombinator.com/item?id=48076195>; <https://www.rapidevelopers.com/lovable-issues/fixing-layout-issues-in-lovable-on-mobile-devices>; <https://dolthub.com/blog/2026-04-21-vibe-pixel-pushing/>; <https://ishadeed.com/article/defensive-css/>

<a name="11-zoom-disabled"></a>

### 11. Pinch zoom blocked by the viewport meta

`zoom-disabled` | tier A | VISUAL.md: not covered (a cheap meta parse; accessibility tier) | injectors: `viewport-zoom-blocked`

- **Renders:** Visitors cannot pinch to enlarge small text or images. Android honours the block; iOS Safari has ignored user-scalable=no since iOS 10.
- **Why AI-generated code does it:** maximum-scale=1 and user-scalable=no are added to stop iOS input zoom (see `ios-input-zoom`) or to make a web app feel native.
- **How common:**
  - [Harvv]: zoom blocked on 18% of 85 AI-built sites. [Almanac25]: zoom disabled on 15% of desktop and 13% of mobile pages, maximum-scale=1 on 19% and 17%, either on 21% and 19%.
  - [LovCSS]: only 171 of 31,744 Lovable index.html files contain maximum-scale and 186 user-scalable (about 0.6%), so Lovable's template is mostly clean and the problem comes from later edits and other builders.
- **Detection (cost: events):** Parse meta[name=viewport] for user-scalable=no or 0, or maximum-scale under 2 (the axe meta-viewport rule).
- **False-positive traps:** Maps, games and drawing canvases that manage zoom themselves (still an accessibility report, low severity); iframe embeds.
- **Fault injection:** Set the viewport meta content to width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no.
- **Fix:** Remove both limits; fix input zoom with 16px input text instead.
- **Sources:** <https://harvv.com/research/lovable-friction-tax>; <https://almanac.httparchive.org/en/2025/accessibility>; <https://dequeuniversity.com/rules/axe/4.8/meta-viewport>; <https://news.ycombinator.com/item?id=49008151>

<a name="24-viewport-100vh"></a>

### 24. 100vh and h-screen sections cut off on phones

`viewport-100vh` | tier B | VISUAL.md: not covered | injectors: `vh-hero-cta-bottom`

- **Renders:** 100vh equals the large viewport on mobile browsers, so full-height heroes put their bottom CTA under the toolbar, h-screen chat shells hide the composer, maps and app shells do not fit, and bottom bars jump as the toolbar shows and hides. With overflow hidden, content is clipped on short or landscape phones.
- **Why AI-generated code does it:** h-screen and min-h-screen (100vh) are the default AI layout primitives; dvh and svh are rarer in training data.
- **How common:**
  - [Corpus]: 100vh or h-screen in 365 of 375 repos (97%); 122 of 375 (33%) never use dvh, svh or -webkit-fill-available, including 94 of 110 bolt repos (85%). [LovCSS]: 1,784 Lovable index.css files contain 100vh against 220 with dvh.
  - Stack Overflow 37112218 (100vh not constant in mobile browsers) about 561k views. OpenReplay measured an iPhone 13 hero at 844px against 792px visible. A Base44 user reports the AI failing 16 times to fix a 100vh map; React Doctor ships a prefer-dvh-over-vh rule.
- **Detection (cost: scan):** Static: rules setting height or min-height to 100vh (or matching a 100vh probe's computed height and not a 100dvh probe) on elements with an interactive descendant in their bottom 15%. Headless browsers have no dynamic toolbar, so report from rules plus geometry; ground truth needs a device farm.
- **False-positive traps:** Desktop; dvh or svh already used; decorative full-height backgrounds with nothing at the bottom; content that scrolls inside; full-screen snap sections on purpose.
- **Fault injection:** Set the hero to height:100vh;overflow:hidden with its CTA at bottom:16px, or an app shell to height:100vh with the composer at the bottom; test at a viewport 60 to 80px shorter than the vh basis.
- **Fix:** min-h-svh or min-h-dvh with a 100vh fallback; keep CTAs out of the bottom 80px of full-height blocks.
- **Sources:** <https://stackoverflow.com/questions/37112218>; <https://blog.openreplay.com/fix-100vh-mobile-viewport/>; <https://web.dev/blog/viewport-units>; <https://www.reddit.com/r/Base44/comments/1re9eaq/>; <https://www.react.doctor/docs/rules/react-doctor/prefer-dvh-over-vh>; <https://ben.page/tailwind-h-screen>

<a name="25-whitespace-anomaly"></a>

### 25. Unexpected blank bands

`whitespace-anomaly` | tier B | VISUAL.md: not covered | injectors: `whitespace-band`

- **Renders:** Large empty areas at the bottom of the page or between sections, usually on mobile only.
- **Why AI-generated code does it:** min-h-screen on every section, fixed heights sized for desktop images, visibility hidden or opacity 0 used where display none was meant, spacer divs, absolute content leaving its container behind.
- **How common:** [XCompat]: whitespace anomaly (a blank band absent from the reference render) in 13.8% of failing AI pairs.
- **Detection (cost: scan):** At 375px, scan the full page for vertical bands taller than 0.6 of innerHeight where no visible text, image or control rect intersects (or a uniform-colour run in a full-page screenshot), compared with the desktop render; also document height minus the lowest content bottom over 0.25 of innerHeight.
- **False-positive traps:** Deliberate breathing room in minimal designs (bands under one viewport); full-bleed background-image heroes (count the image as content); lazy placeholders that fill later; footers pushed down by min-height 100vh on short pages.
- **Fault injection:** footer{margin-top:120vh}, or give an empty section min-height:100vh at mobile widths, or a section height:1200px with its content absolute at the top.
- **Fix:** Content-driven heights; no min-h-screen on content sections; display none for removed elements.
- **Sources:** <https://arxiv.org/html/2608.12518v1>

<a name="53-text-scaling-breaks"></a>

### 53. Layout breaks under larger text, browser zoom or text-spacing settings

`text-scaling-breaks` | tier B | VISUAL.md: not covered | injectors: `text-scale-200`

- **Renders:** At 200% zoom or a larger default font size, labels truncate, components overlap, containers clip and horizontal scrollbars appear; text sized only in vw does not grow with zoom; fixed bars sized in vh cover more content as the visitor pinches in.
- **Why AI-generated code does it:** Fixed heights, px font sizes and px containers; fluid hero text in vw without a rem term; layouts tested only at default size.
- **How common:**
  - [SUD]: scale settings in 51 of 308 bugs (font size 37, display size 14). dVermin found 21 new scaling issues, 20 confirmed or fixed. [Almanac25]: px font units on 67% of desktop pages.
  - [HN]: pages that cannot zoom without falling apart; a Claude-built tool with a Safari-only overflow that shows only at larger font size.
- **Detection (cost: scan):** Before and after comparison: render at default, then with html{font-size:200%} and with the WCAG 1.4.12 text-spacing overrides (line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em, paragraph spacing 2em), and at 320 CSS px (400% zoom of 1280, WCAG 1.4.10). Re-run the clipping, overlap and overflow detectors and report only new findings, comparing containment and overlap relations rather than coordinates. Flag text whose size does not change when the root size doubles.
- **False-positive traps:** Intended reflow (rows stacking) is not a failure; maps, canvases and data grids exempt under reflow; icons sized in px on purpose.
- **Fault injection:** Inject html{font-size:200%}, or the text-spacing set; or h1{font-size:6vw} p{font-size:1.05vw} with a 1100px container.
- **Fix:** rem units with clamp(rem, vw, rem) for fluid type, min-height instead of height, allow wrapping.
- **Sources:** <https://arxiv.org/html/2607.04120v1>; <https://arxiv.org/abs/2212.04388>; <https://almanac.httparchive.org/en/2025/accessibility>; <https://www.w3.org/WAI/WCAG22/Understanding/reflow>; <https://news.ycombinator.com/item?id=48787602>; <https://news.ycombinator.com/item?id=48510699>

<a name="55-content-hidden-mobile"></a>

### 55. Content hidden on phones with no replacement

`content-hidden-mobile` | tier B | VISUAL.md: not covered | injectors: `mobile-section-hidden`

- **Renders:** Key sections, pricing details, filters, CTAs or images present on desktop are display none on phones, with no alternative.
- **Why AI-generated code does it:** Responsive utilities used to fix a mobile layout by deleting the element.
- **How common:** [XCompat]: visibility failure in 2.1% of failing pairs; hidden element with no replacement is a root cause on 2.2% of failing AI pages. pixelslop warns against hiding content with display none on mobile.
- **Detection (cost: scan):** Diff visible text blocks and images between 1280px and 375px renders; flag substantive content (over 40 characters, or an img over 100px) present on desktop and absent on mobile with no equivalent text elsewhere on the mobile page.
- **False-positive traps:** Decorative imagery removed on mobile; duplicated desktop and mobile variants; content moved into an accordion.
- **Fault injection:** At max-width 767px set the third section to display:none.
- **Fix:** Restack instead of hiding; collapse behind a disclosure if needed.
- **Sources:** <https://arxiv.org/html/2608.12518v1>; <https://cdn.jsdelivr.net/npm/pixelslop@0.3.8/dist/skill/resources/adapt.md>

<a name="57-breakpoint-gaps"></a>

### 57. Failures at in-between widths and narrow width ranges

`breakpoint-gaps` | tier B | VISUAL.md: not covered | injectors: `breakpoint-small-range`

- **Renders:** Layouts that work at 375 and 1280 break at 834 (iPad portrait), 900 or 1024 to 1100, or at only 1 to 5 widths where max-width:768px and min-width:768px both apply; the last item of a single-line group drops alone to a new row.
- **Why AI-generated code does it:** Only Tailwind's default breakpoints are used with fixed columns between them; hand-written queries mix max-width and min-width at the same value.
- **How common:**
  - [ReDeCheck] (human-built sites): responsive layout failures in 16 of 26 live sites; 195 small-range reports across 25 sites (147 on one site, one distinct failure); 14 wrapping failures. [VERVE] matched manual labels 98.5% on small-range and 78.6% on wrapping failures.
  - A practitioner list of visual bugs AI generators ship names missing in-between breakpoints.
- **Detection (cost: scan):** Run the layout checks across a width sweep (320 to 1440 in 16px steps, or 360, 390, 414, 600, 768, 834, 900, 1024, 1180, 1280) and report failing width ranges. Parse CSSMediaRule conditions to collect breakpoints and render each at -2 to +2px; build a relative-alignment graph and flag relations that change at w and revert within 5px; group siblings into rows by top and flag n becoming n-1 plus one lone item.
- **False-positive traps:** Coincidental alignment changes; fluid layouts that change continuously; card grids where a partly filled last row is normal.
- **Fault injection:** [VERVE] recipe: @media (min-width:992px) and (max-width:995px){target{margin-left:40px}}; or copy a rule from max-width:768px into min-width:768px; or a 3-column grid of 360px columns that switches only at 1024px.
- **Fix:** Mobile-first min-width queries only, or exclusive bounds (max-width:767.98px); fluid grids with auto-fill and minmax; container queries.
- **Sources:** <https://eprints.whiterose.ac.uk/id/eprint/116989/>; <https://eprints.whiterose.ac.uk/165542/>; <https://dev.to/oqa/vibe-coding-problems-7-visual-bugs-ai-code-generators-always-ship-37mf>

<a name="58-rtl-and-translation"></a>

### 58. Layout breaks under RTL or translated text length

`rtl-and-translation` | tier B | VISUAL.md: not covered (VISUAL.md abstains under browser translation) | injectors: `rtl-flip`, `pseudo-localize`

- **Renders:** With dir=rtl, margins, paddings, icon placement, alignment and drawers do not mirror and chevrons point the wrong way; longer translated strings overflow or overlap.
- **Why AI-generated code does it:** Models emit ml-, mr-, left-, right- and text-left by default; logical utilities (ms-, me-, start-, end-) are rare in training data; widths sized to English strings.
- **How common:**
  - [Corpus]: 28,200 physical direction utilities against 43 logical ones in app markup; only 1 of 380 repos mentions RTL.
  - [SUD]: language settings in 35 of 308 bugs (RTL 19). Internationalization presentation failures across 54 web apps (ICST 2016); IFix repaired 23 pages. [Halle]: French text causing overlap.
- **Detection (cost: scan):** Pseudo-localize (lengthen strings 30 to 100%, add accents) and set dir=rtl; re-run overlap, clipping and overflow detectors and compare relations with the default render (mirrored relations count as intended under RTL); scan the CSSOM for physical properties on rendered elements when the page declares an RTL lang.
- **False-positive traps:** LTR-only products; symmetric spacing; icons that should not flip; brand names.
- **Fault injection:** Set dir='rtl' on html of a page using physical margins for icon spacing; or replace text nodes with 1.5x-length pseudo-locale strings.
- **Fix:** Logical properties and utilities (ms-, me-, ps-, pe-, start-, end-, text-start), flexible widths, wrapping.
- **Sources:** <https://arxiv.org/html/2607.04120v1>; <https://www.w3.org/International/articles/article-text-size>; <https://computer.org/csdl/proceedings-article/icst/2016/1827a202/12OmNy6HQS6>; <https://eprints.whiterose.ac.uk/163401>; <https://arxiv.org/abs/1608.07883>

<a name="74-ios-input-zoom"></a>

### 74. iOS zooms the page on input focus (form text under 16px)

`ios-input-zoom` | tier C | VISUAL.md: not covered | injectors: `input-font-14`

- **Renders:** Tapping an email or search field zooms the page; the field ends up half off screen and the layout does not zoom back out.
- **Why AI-generated code does it:** text-sm (14px) inputs for a dense look; shadcn Input uses text-base md:text-sm, which drops to 14px from 768px (iPads, landscape phones), and hand-written or restyled inputs drop the 16px base.
- **How common:** Stack Overflow 2989263 (disable auto zoom on input in iPhone Safari) about 905k views. A Lovable QA post says it happens in almost every Lovable app it checks. [HN]: a sign-in field that zooms with half of it off the page. The shadcn source encodes the workaround.
- **Detection (cost: pass):** Under a mobile profile: visible text-entry input (text, email, search, password, number, tel, url), select and textarea with computed font-size under 16px.
- **False-positive traps:** Only iOS zooms, so report under iOS or mobile profiles; read-only or hidden inputs; a transform scale on a 16px input.
- **Fault injection:** Inject input,select,textarea{font-size:14px!important} at max-width 767px.
- **Fix:** 16px on touch devices (text-base md:text-sm), not maximum-scale.
- **Sources:** <https://stackoverflow.com/questions/2989263>; <https://www.reddit.com/r/lovable/comments/1wf4407/>; <https://news.ycombinator.com/item?id=44614893>; <https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/input.tsx>; <https://defensivecss.dev/tips/>

<a name="93-safe-area-keyboard"></a>

### 93. Fixed bars under the notch, home indicator or on-screen keyboard

`safe-area-keyboard` | tier C | VISUAL.md: not covered | injectors: `safe-area-ignored`

- **Renders:** In wrapped iOS and Android builds (Capacitor, Despia) and mobile browsers: white bars at the top or bottom, headers under the status bar, bottom nav under the home indicator, double padding when header and nav both add insets, or the keyboard covering the input being typed into.
- **Why AI-generated code does it:** viewport-fit=cover without env(safe-area-inset-\*) padding, or the inset applied in several places; fixed bottom-0 composers inside 100vh shells with no visualViewport or interactive-widget handling.
- **How common:** [Reddit]: 4 strict-match posts (Lovable 3, Base44 1), all from people shipping builder apps to the App Store. AppInstitute: vibe-coded apps ship with the keyboard covering the input box. Tailwind PR #19921 (safe area utilities) 36 reactions. Stack Overflow 23023549 (viewport height with soft keyboard) about 86k views.
- **Detection (cost: scan):** With viewport-fit=cover: fixed or sticky top and bottom bars whose padding does not reference env(safe-area-inset-\*), or both a parent and a child applying it. After focusing an input under a mobile profile, its rect.bottom > visualViewport.height + visualViewport.offsetTop. Headless keyboard simulation is unreliable, so report the static pattern as a risk.
- **False-positive traps:** Plain browser contexts where insets are 0; desktop; pages using interactive-widget=resizes-content or the VirtualKeyboard API; Android resizes differently.
- **Fault injection:** Set the viewport meta to width=device-width,initial-scale=1,viewport-fit=cover and remove safe-area padding from a fixed bottom nav and header.
- **Fix:** Apply env(safe-area-inset-\*) once on the outer fixed bars; dvh shells; visualViewport-aware positioning or interactive-widget=resizes-content.
- **Sources:** <https://www.reddit.com/r/lovable/comments/1qpdwaf/>; <https://www.reddit.com/r/Base44/comments/1rmab2v/>; <https://appinstitute.com/is-my-vibe-coded-app-ready/>; <https://github.com/tailwindlabs/tailwindcss/pull/19921>; <https://stackoverflow.com/questions/23023549>

## Alignment, spacing and consistency

Report-only design quality: nothing is broken, but the page looks unfinished.

<a name="23-misalignment"></a>

### 23. Near-miss alignment (edges, baselines, icons, card rows)

`misalignment` | tier B | VISUAL.md: not covered (design quality, report-only) | injectors: `align-nudge`, `align-icon-baseline`, `align-card-cta`

- **Renders:** Elements that should line up are 1 to 8px off: list items, card titles, form fields, buttons in a row; icons sit above or below the text baseline; arrows not centred in round buttons; card CTAs at different heights because text lengths differ; a lone last-row item stretches full width.
- **Why AI-generated code does it:** Each element gets its own spacing utilities instead of a shared container rule; inline SVGs default to baseline alignment; card footers lack mt-auto; auto-fit instead of auto-fill.
- **How common:**
  - [DesignBench] (real pages): alignment is 42.2% of display issues, the largest category. [WebGenV]: alignment and spacing were the most frequent low-score categories for Claude Opus 4.1, GPT-5 and Gemini 2.5 Pro. [SUD]: alignment inconsistency in 63 of 308 bugs.
  - A widely discussed list of tells of a slop UI (386 points on HN) includes misaligned elements, with commenters pointing at off-centre icons and arrows. Stack Overflow 18744164 (align last flex row to grid) about 352k views.
- **Detection (cost: pass):** Report-only. Cluster left, right, top and baseline edges of repeated siblings with the same tag and class signature; flag edges 1 to 8px from the cluster mode. For icon plus text rows, compare the icon's vertical centre with the first line box centre (over 2px or 12% of line-height). For card rows sharing a top edge, flag primary button bottoms that differ by more than 4px.
- **False-positive traps:** Optical adjustments, centred items of different widths, intentional indentation, masonry layouts, featured cards, sub-pixel rounding, transforms mid-animation, emoji glyph metrics.
- **Fault injection:** margin-left:3px on one list item ([Halle]'s example); padding-top:2px on one card title; align-items:flex-start with svg margin-top:5px on icon rows; remove mt-auto from card footers with varied text.
- **Fix:** Shared container alignment (grid, gap, inline-flex items-center), no per-item offsets, flex-col plus mt-auto for card actions.
- **Sources:** <https://arxiv.org/html/2506.06251v3>; <https://arxiv.org/html/2510.15306v1>; <https://arxiv.org/html/2607.04120v1>; <https://godobject.dev/blog/10-tells-of-slop>; <https://news.ycombinator.com/item?id=49867038>; <https://stackoverflow.com/questions/18744164>; <https://arxiv.org/abs/1608.07883>

<a name="41-crowding"></a>

### 41. Crowding (too little spacing between elements)

`crowding` | tier B | VISUAL.md: not covered (design quality) | injectors: `crowd-zero-gap`

- **Renders:** Elements packed with little or no gap; text touching card borders; tap targets abutting.
- **Why AI-generated code does it:** Spacing utilities approximated or omitted per generation pass.
- **How common:** [DesignBench] (real pages): crowding is 18.7% of display issues. [WebCompass] has a crowding repair type.
- **Detection (cost: pass):** Report-only: adjacent visible text-bearing or interactive siblings with a gap under 4px; text closer than 4px to the edge of a container with a visible border or background.
- **False-positive traps:** Segmented controls and button groups with shared borders; dense data tables; inline text runs.
- **Fault injection:** Set gap:0 and padding:0 on a card list.
- **Fix:** Spacing tokens; padding inside bordered containers.
- **Sources:** <https://arxiv.org/html/2506.06251v3>; <https://arxiv.org/html/2604.18224v1>

<a name="42-design-drift"></a>

### 42. Spacing, type and colour drift across repeated components

`design-drift` | tier B | VISUAL.md: not covered (v2 per-app expectations territory) | injectors: `drift-padding-colour`

- **Renders:** The same component uses different paddings, gaps, radii or near-identical brand shades in different places; a landing page uses 10 to 15 distinct font sizes; random line-height jumps. It works but looks unfinished.
- **Why AI-generated code does it:** Views are generated one at a time and the model does not reuse the values chosen elsewhere; each pass picks the nearest utility or an arbitrary text-[13px] instead of a token. DesignRepair found LLMs tend to predict larger property values.
- **How common:**
  - [WebGenV]: spacing among the most frequent low-score categories for all three frontier models. DesignRepair: v0 projects had 9.8 guideline violations per project against 1.74 per file in GitHub projects. [SUD]: distance inconsistency in 36 of 308 bugs.
  - [Reddit]: 34 strict-match posts, about 45% on topic (about 15). [HN]: a review counting 15 different text sizes on one page; font, icon and panel sizes all over the place. OverlayQA (vendor) puts layout issues including spacing at 40 to 50% of its findings.
- **Detection (cost: pass):** Report-only. Group repeated instances by structural signature and compare computed padding, gap, font-size, radius and colours; flag the instance that deviates from the group mode (colour deltaE over 3). Histogram computed spacing values off a 4px scale and count distinct font sizes (rounded to 0.5px, clustered within 1px for clamp()); flag more than about 10.
- **False-positive traps:** Prose and CMS content; deliberate featured variants; optical adjustments; fluid type; third-party embeds; hover state captured mid-interaction.
- **Fault injection:** Set sibling card paddings to 13, 16 and 18px; one button background to #2463ea when the rest are #2563eb; label font sizes 15px against 16px; add several arbitrary heading sizes.
- **Fix:** Spacing, type and colour tokens; reuse components instead of regenerating them.
- **Sources:** <https://arxiv.org/html/2510.15306v1>; <https://arxiv.org/html/2411.01606v2>; <https://arxiv.org/html/2607.04120v1>; <https://www.reddit.com/r/lovable/comments/1x1k7b1/>; <https://news.ycombinator.com/item?id=49451580>; <https://overlayqa.com/blog/ai-app-builders-visual-bugs/>

## Other

Accessibility semantics, engine differences, regressions after edits, and minor CSS defects.

<a name="37-placeholder-only-labels"></a>

### 37. Form fields labelled only by placeholder text

`placeholder-only-labels` | tier B | VISUAL.md: not covered | injectors: `labels-to-placeholders`

- **Renders:** The field's purpose disappears as soon as the visitor types; the grey placeholder often also fails contrast.
- **Why AI-generated code does it:** Minimal newsletter, search and login fields are generated with placeholder text and no label.
- **How common:** [WebAIM26]: missing form input labels on 51% of home pages. accessiBe (vendor) audits of two Lovable storefronts found placeholder-only labels on 2 and 3 fields.
- **Detection (cost: pass):** input and textarea with a placeholder, no associated label element, and no visible text adjacent to it (aria-label alone gives no visible label).
- **False-positive traps:** Search fields with a visible search button and icon; floating-label patterns.
- **Fault injection:** Remove `<label>` elements from a form and move their text into placeholder attributes.
- **Fix:** Visible labels.
- **Sources:** <https://webaim.org/projects/million/>; <https://accessibe.com/accessibility-platform/reports/gen-ai-ecommerce/accessibility-audit>

<a name="49-emoji-as-icons"></a>

### 49. Emoji used as UI icons, and flag emoji on Windows

`emoji-as-icons` | tier B | VISUAL.md: not covered | injectors: `emoji-nav-icons`

- **Renders:** Navigation items, buttons and feature lists use emoji: they render differently per OS, ignore CSS colour, sit misaligned against text and are read aloud by screen readers. Country-flag emoji show as two letters on Windows, which ships no flag glyphs.
- **Why AI-generated code does it:** Emoji are the cheapest icon a model can emit without imports.
- **How common:** [Corpus]: emoji in markup in 237 of 375 repos (63%), 10 or more in 112 (30%); regional-indicator flag pairs in 20 (5%). [Krebs] scores nav items with emoji icons; unslop-ui reports emoji in 0.5% of the comments it analysed. A Lovable post about flags missing on desktop.
- **Detection (cost: pass):** Text nodes inside nav, button, a, li and headings whose first grapheme matches `\p{Extended_Pictographic}`; flag 3 or more in navigation or feature lists, and emoji inside interactive elements without aria-hidden. Regional-indicator pairs (U+1F1E6 to U+1F1FF) visible on a Windows user agent.
- **False-positive traps:** User-generated content, chat apps, reaction pickers, brands with an intentional emoji voice.
- **Fault injection:** Prefix nav links and feature headings with emoji; replace a language picker's flag images with flag emoji.
- **Fix:** An SVG icon set with aria-hidden, sized and aligned to the text; SVG flags.
- **Sources:** <https://www.adriankrebs.ch/blog/design-slop/>; <https://github.com/talkjs/country-flag-emoji-polyfill>; <https://www.reddit.com/r/lovable/comments/1srzle2/>; <https://skillsmp.com/creators/iamneilroberts/claude-skills/skills-unslop-ui>

<a name="67-cross-browser"></a>

### 67. Rendering differs between Chromium, WebKit and Gecko

`cross-browser` | tier B | VISUAL.md: not covered (VISUAL.md marks Chromium-only kinds) | injectors: `engine-gated-shift`

- **Renders:** The same page lays out or styles differently across engines: native controls, unsupported features, browser defaults; FAQ text hidden behind a background only in Firefox; elements disappearing in one engine.
- **Why AI-generated code does it:** Testing only in Chromium previews; newer CSS features.
- **How common:**
  - [XCompat]: cross-browser-only failures on 1.0% of AI pages against 67.5% cross-device; browser defaults the root cause on 1.4%. [XBIDetective]: 243 of 1,052 usable web-compat reports showed a cross-browser inconsistency; a fine-tuned VLM reached 79% accuracy; pop-ups were the largest source of misses (31 of 106).
  - [HN]: several Firefox-only invisibility reports on vibe-coded sites, causes not diagnosed.
- **Detection (cost: scan):** Render in Chromium, WebKit and Firefox (Playwright); match elements by XPath and text; compare rects within a tolerance; mask ads and dynamic content first (in [XBIDetective] masking lifted accuracy from 68% to 77%).
- **False-positive traps:** Font rasterization and anti-aliasing; native control styling; carousels, ads, personalized content; pop-ups.
- **Fault injection:** Add a browser-gated rule, for example @supports (-moz-appearance:none){target{margin-top:30px}}, for a Firefox-only shift.
- **Fix:** Feature queries; normalize control styling; test in all three engines.
- **Sources:** <https://arxiv.org/html/2608.12518v1>; <https://arxiv.org/html/2512.15804v1>; <https://doi.org/10.1145/3580518>; <https://news.ycombinator.com/item?id=49870451>

<a name="81-export-render-broken"></a>

### 81. PDF, image and print output that fails, comes out blank or gets cut off

`export-render-broken` | tier C | VISUAL.md: not covered | injectors: `export-oklch-html2canvas`, `print-styles-removed`, `control-print-hides-chrome`

- **Renders:** 'Download PDF', 'Export as image' or 'Share card' buttons in generated apps (invoices, resumes, certificates, reports) throw and produce nothing, or produce a blank or clipped image. Printing gives the nav bar and fixed bars over the content, cut-off pages, or missing backgrounds.
- **Why AI-generated code does it:** Models reach for html2canvas, html2pdf.js or jsPDF.html(), all of which use html2canvas 1.4.1. That library has been unmaintained since January 2022, and it throws 'Attempting to parse an unsupported color function "oklch"' on Tailwind v4 colours and shadcn's oklch tokens. Elements outside the viewport, cross-origin images and fixed elements also capture wrongly. window.print() buttons ship without any print styles.
- **How common:**
  - [Corpus] re-scan: 16 of 377 repos (4%) use html2canvas or html2pdf. None of the 16 is on Tailwind v4 yet, so the oklch failure is latent there. 20 repos call window.print(), and 5 of those have no print styles.
  - GitHub issue search: 201 issues and PRs mention '"unsupported color function" oklch' (html2canvas #3150 with 14 comments, html2pdf.js #729 with 10 reactions, #829 with 8). npm, last month: html2canvas 82.3M downloads; html2canvas-pro, the fork that parses oklch, 8.1M. [LovCommits]: 5,536 'fix "pdf export"', 1,044 'fix html2canvas', 44 'fix oklch'.
  - [Reddit]: a Base44 post about PDF export and downloads not working, and a Cursor post about resume PDF export pagination.
- **Detection (cost: events for export, scan for print):** Export: after a click on a control whose text matches export, download, PDF or save as image, listen for console errors and unhandled rejections matching `/unsupported color function|html2canvas|toDataURL/`, and report when no download, blob URL or new window follows within 5 s. Print: emulate print media in the harness and check that fixed or sticky elements, nav bars and footers do not cover content, that text stays inside the page width, and that light text does not depend on a dark background (browsers drop backgrounds when printing by default).
- **False-positive traps:** Server-side exports (no client library involved). Intentional print layouts. print-color-adjust: exact used on purpose. Downloads blocked by the test browser (accept downloads in the harness). Export buttons that open a dialog first.
- **Fault injection:** On a page with an html2canvas-based export, force oklch() text and background colours on the main region and click the export control; or delete every @media print rule and emulate print media. Control: a print stylesheet that hides the header, nav and footer and sets dark text on white. The second control the gap review proposed, the same export with html2canvas-pro or html-to-image loaded in place of html2canvas, needs a page built for it and has no recipe.
- **Fix:** Use html2canvas-pro or html-to-image (SVG foreignObject), or generate PDFs on the server. Add @media print rules that hide the nav and fixed bars, set dark text on white, and control page breaks.
- **Sources:** <https://github.com/niklasvh/html2canvas/issues/3150>; <https://github.com/niklasvh/html2canvas/issues/3269>; <https://github.com/niklasvh/html2canvas/issues/3287>; <https://github.com/eKoopmans/html2pdf.js/issues/729>; <https://github.com/eKoopmans/html2pdf.js/issues/829>; <https://github.com/yorickshan/html2canvas-pro>; <https://api.npmjs.org/downloads/point/last-month/html2canvas>; <https://api.npmjs.org/downloads/point/last-month/html2canvas-pro>; <https://www.reddit.com/r/Base44/comments/1o6brk2/>; <https://www.reddit.com/r/cursor/comments/1jqgwx4/>

<a name="95-visual-regression-after-edit"></a>

### 95. Visual regressions after an AI edit

`visual-regression-after-edit` | tier C | VISUAL.md: not covered (v2 per-app expectations) | injectors: `regression-token-swap`

- **Renders:** A prompt about one thing changes colours, layout, fonts or copy elsewhere; the builder reverts the frontend to an older look, or says it reverted and nothing changed.
- **Why AI-generated code does it:** Regeneration rewrites whole components and drops hand-added classes; the model does not keep earlier design decisions in context.
- **How common:** [Reddit]: 11 visual-specific posts (Bolt changed colours, design, layout and copy; Cursor turned a custom design into generic components; Lovable frontends reverting) plus about 20 saying each fix breaks something else. An agency writes about Lovable UI resets after regeneration. [DiffSpot]: the best VLM recalled 40.7% of single-property changes and the median model 4% for line-height, so pixel or DOM diffing is needed.
- **Detection (cost: scan):** Per-route baseline of a computed-style fingerprint (colours, fonts, spacing of landmark components) plus a low-resolution screenshot and a relative layout graph ([ReDeCheck] alignment and containment relations); report diffs above a threshold after each deploy, report-first.
- **False-positive traps:** Intended redesigns, A/B tests, dynamic content, seasonal banners, late fonts.
- **Fault injection:** Between two captures of a page, change --primary, swap the heading font and reorder two sections; or apply one [Walsh] mutation operator (class add, delete or modify, text, declaration value or unit, media query expression or breakpoint).
- **Fix:** Lock design tokens and shared components, ask for scoped edits, keep visual snapshots in CI.
- **Sources:** <https://www.reddit.com/r/boltnewbuilders/comments/1n0z4iv/>; <https://www.reddit.com/r/cursor/comments/1jep70z/>; <https://www.reddit.com/r/lovable/comments/1kdrhgu/>; <https://www.hirelovableexperts.com/mobile/lovable-ui-resets-after-ai-regeneration>; <https://arxiv.org/html/2605.29615v1>; <https://eprints.whiterose.ac.uk/163400>

<a name="102-links-indistinguishable"></a>

### 102. Inline links indistinguishable from body text

`links-indistinguishable` | tier D | VISUAL.md: not covered | injectors: `inline-links-plain`

- **Renders:** Links inside paragraphs have the text colour and no underline, so visitors cannot see them (WCAG 1.4.1).
- **Why AI-generated code does it:** Tailwind Preflight resets links to color inherit and text-decoration inherit, and generated prose forgets to restyle them.
- **How common:** Every Tailwind page inherits the reset unless restyled; prevalence in AI output not measured. axe rule link-in-text-block targets it.
- **Detection (cost: pass):** a[href] with sibling text in the same block whose computed colour matches the surrounding text (or link-to-text contrast under 3:1) with text-decoration-line none and no border-bottom or background.
- **False-positive traps:** Nav and card links where context makes the link obvious; links that are the whole block.
- **Fault injection:** Inject article a, p a{color:inherit;text-decoration:none}.
- **Fix:** Underline inline links (the prose plugin, or a base rule).
- **Sources:** <https://github.com/tailwindlabs/tailwindcss/blob/main/packages/tailwindcss/preflight.css>; <https://www.w3.org/WAI/WCAG22/Understanding/use-of-color>

<a name="103-color-only-state"></a>

### 103. State conveyed by colour only (sale prices, errors, statuses)

`color-only-state` | tier D | VISUAL.md: not covered | injectors: `error-colour-only`

- **Renders:** Sale against original price, invalid fields and status chips differ only by red or green colour, which colour-blind visitors and screen readers miss.
- **Why AI-generated code does it:** Generated components style states with text-red-500 or bg-green-500 alone.
- **How common:** accessiBe (vendor): one of two Lovable storefronts distinguished sale and original prices only by colour and strikethrough.
- **Detection (cost: pass):** Sibling elements with the same structure that differ only in computed colour (no icon, text, weight or decoration difference); inputs with aria-invalid whose only visual change is border-color.
- **False-positive traps:** Colour plus a text label; decorative colour coding.
- **Fault injection:** Remove the error icon and message from invalid fields and keep only a red border.
- **Fix:** Add text, icons or patterns alongside colour.
- **Sources:** <https://accessibe.com/accessibility-platform/reports/gen-ai-ecommerce/accessibility-audit>; <https://www.w3.org/WAI/WCAG22/Understanding/use-of-color>

### Minor CSS defects

Low frequency or low impact, all tier D. Each has one injector.

| # | id | renders | detection (cost) | injection | fix | source |
|---|---|---|---|---|---|---|
| 111 | <a name="111-sticky-hover-touch"></a>`sticky-hover-touch` | On phones, tapping a card or button applies its hover lift, scale, shadow or colour, and the state stays after the finger lifts until the visitor taps elsewhere, so a card looks selected. Tailwind v3 emits plain :hover rules (v4 wraps them in @media (hover: hover)); 229 of 326 Tailwind v3 repos (70%; Lovable 120 of 153) use a hover translate, scale or large shadow, and Lovable has 1,931 'fix "hover" mobile' commits. Common, low impact. | In a touch WebKit or mobile Chromium harness, tap an element whose hover style changes transform or box-shadow, release, wait 500 ms, and report when it still matches :hover with that style and no menu opened or navigation followed. (scan) | Add card :hover rules with an 8px lift and a large shadow, then tap one card that is not a link under touch WebKit at 390x844. (`hover-sticky-after-tap`) | Gate hover effects with @media (hover: hover): the v4 default, and future.hoverOnlyWhenSupported in a v3 config. | <https://tailwindcss.com/docs/upgrade-guide#hover-styles-on-mobile> |
| 112 | <a name="112-translate-blur"></a>`translate-blur` | Dialogs centred with percentage translates land on half pixels and text renders blurry in some engines (shadcn DialogContent uses this). | Text-bearing elements with percentage translate whose rect x or y ends in .5. (pass) | Give a centred dialog an odd height such as 401px. (`dialog-odd-height`) | Centre with grid place-items or round the offsets. | <https://stackoverflow.com/questions/31109299> |
| 113 | <a name="113-safari-radius-flash"></a>`safari-radius-flash` | Card images that scale on hover inside rounded-xl overflow-hidden briefly show square corners in Safari. | border-radius plus overflow hidden with a child that has a transform transition, under WebKit. (pass) | Add transition transform and :hover scale(1.05) to an img in a rounded overflow-hidden card. (`radius-transform-safari`) | isolation isolate or mask-image on the wrapper. | <https://stackoverflow.com/questions/25891362> |
| 114 | <a name="114-inline-image-gap"></a>`inline-image-gap` | A few px of space under images inside boxes, misaligning cards and borders (non-Tailwind outputs; Preflight sets display block). | img with display inline whose parent is 2 to 6px taller than the img with no padding. (pass) | Inject img{display:inline} on a Tailwind page. (`img-inline`) | img{display:block} or vertical-align middle. | <https://stackoverflow.com/questions/5804256> |
| 115 | <a name="115-background-tiling"></a>`background-tiling` | A background image smaller than its section repeats visibly on wide or tall screens. | background-repeat repeat with an image smaller than the element box. (pass) | Remove background-repeat no-repeat and background-size cover from a hero. (`bg-repeat`) | background-repeat no-repeat; background-size cover. | <https://defensivecss.dev/tips/> |
| 116 | <a name="116-vendor-selector-group"></a>`vendor-selector-group` | ::-webkit-input-placeholder, ::-moz-placeholder grouped in one rule is invalid in every engine, so no placeholder styling applies. | Author stylesheet text with selector lists mixing vendor pseudo-elements that are missing from the CSSOM. (pass) | Rewrite the placeholder rules as one grouped rule. (`vendor-grouped`) | One rule per vendor selector, or :is()/:where(). | <https://defensivecss.dev/tips/> |
| 117 | <a name="117-light-image-edge"></a>`light-image-edge` | Product shots and avatars with white backgrounds lose their edges on white cards. | Edge pixel luminance within a small delta of the parent background and no border or outline (harness pixels). (scan) | Remove the outline and ring from product images on white cards. (`image-outline-removed`) | An inset box-shadow or a semi-transparent outline on images. | <https://defensivecss.dev/tips/> |
| 118 | <a name="118-bg-attachment-fixed-ios"></a>`bg-attachment-fixed-ios` | Parallax hero backgrounds become huge, blurry or static on iOS Safari. | Computed background-attachment fixed on large elements under an iOS user agent. (pass) | Set background-attachment:fixed;background-size:cover on the hero. (`bg-fixed-hero`) | A fixed pseudo-element layer, or no parallax on touch. | <https://stackoverflow.com/questions/41436892> |
| 119 | <a name="119-sticky-chrome-short-viewport"></a>`sticky-chrome-short-viewport` | On landscape phones and short laptop windows, a sticky header plus secondary nav plus cookie bar cover most of the screen. | At 568x320 and 1280x600, summed heights of visible fixed and sticky elements over 40% of innerHeight. (scan) | Make a secondary nav sticky below a 72px header and add a fixed 80px cookie bar. (`sticky-stack`) | Sticky only inside @media (min-height: 600px); collapse bars on scroll. | <https://ishadeed.com/article/defensive-css/> |

## Design tells (not defects)

### Generic AI-template look

- **Renders:** Purple-to-indigo gradient hero, glowing accents in permanent dark mode, Inter or Geist everywhere, a pill badge above the H1, three identical icon-topped feature cards, numbered steps, stat rows, emoji nav icons, heavy backdrop blur.
- **How common:** [Reddit]: 134 strict-match posts (vibecoding 75, Lovable 37), about 80% on topic. [HN] Show HN: 77 comments call a launch AI slop or vibe-coded looking. [Krebs]: 22% of about 1,590 Show HN sites hit 4 or more of his 16 patterns. unslop-ui reports generic shadcn styling (2.5% of comments) and purple (2.3%) above gradients (2.0%) and animation (1.1%). Adam Wathan publicly apologized in August 2025 for bg-indigo-500 in Tailwind UI demos.
- **Why it is not ranked as a bug:** Nothing is broken, and a brand can be purple. It is one of the most frequent complaints, so it belongs in a report-only design score built from many weak signals (gradient hues of about 240 to 300 degrees, saturated glow shadows over 24px, Inter or Geist on both h1 and body, repeated sibling cards with an icon first child, emoji as the first child of nav links, backdrop-filter count, a pill directly above h1). Never flag on one signal and never call it a defect. The tells with a measurable failure attached are catalogued as bugs: `text-low-contrast` (muted grey on dark), `gradient-text-invisible`, `text-over-image` (glass), `emoji-as-icons`, `stat-counter-zero`, `scroll-jank`.
- **Sources:** <https://www.adriankrebs.ch/blog/design-slop/>; <https://github.com/AdrianKrebs/design-slop-cop>; <https://news.ycombinator.com/item?id=47864393>; <https://www.reddit.com/r/vibecoding/comments/1q7lmai/>; <https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website>; <https://www.thefountaininstitute.com/blog/signs-vibe-coded-ui>; <https://github.com/pbakaus/impeccable>; <https://skillsmp.com/creators/iamneilroberts/claude-skills/skills-unslop-ui>

## Detection and training notes

What the literature says about detecting these, for the VM training lane:

- **DOM checks confirmed against pixels do best.** [XCompat]'s heuristic DOM plus screenshot detector scored F1 0.903, against 0.85 for LLMs given the DOM only, 0.73 to 0.78 for LLMs given DOM plus screenshot, and 0.45 for ReDeCheck. [VERVE] confirmed DOM reports with an opacity trick and an image diff and agreed with manual labels 86.3% of the time.
- **DOM-only rules over-report.** [ReDeCheck]: 197 of 328 reports were true positives; the false ones came from invisible padding, protrusion hidden by overflow hidden, and elements that only happened to line up. CLAY found 37.4% of Rico screens contain view-tree objects with no visual counterpart.
- **General VLMs are weak at fine detail.** [UILens]: about 20% F1 on text overflow and 31% on container overlap. [DiffSpot]: the best model found 40.7% of single-property changes, the median model 4% of line-height changes. [DesignBench]: models identified the issue 27% of the time. A fine-tuned VLM reached 79% on cross-browser bugs ([XBIDetective]). Screenshot CNNs trained on synthetic faults work: [OwlEyes] reached precision 0.85 and recall 0.84; [Nighthawk] 0.84 and 0.84 for detection but 0.59 AP for localization, occlusion the hardest.
- **Synthetic injection works for training.** On real crowdtest screenshots, training on injected faults lifted [OwlEyes] from precision 0.756 and recall 0.625 to 0.850 and 0.848. Methods to reuse: OwlEyes and Nighthawk paint over part of a text view, redraw text offset by up to half its width, cover an image with a placeholder icon and write null over text; [DiffSpot] keeps a single-property change only if it is visible, local to the target box and the selector resolves; [Walsh]'s 8 operators (class add, delete, modify; text; declaration value; declaration unit; media query expression; breakpoint); [MAEWU]'s 16 live-DOM operators; [Boxy]'s 9 mutants; [VERVE]'s 992 to 995px media query; [WebCompass]'s LLM-injected bugs with exact inverse patches; setting flips (dark mode, font scale, RTL, rotation) as before and after checks.
- **Labels.** Use three verdicts per finding: true positive, false positive, and NOI (real but not observable). Inject from outside the app (AGENTS.md rule 4) and mark targets with `data-bench-fault`, as VISUAL.md section 15 plans. Run the control injectors on every page to measure false reports next to recall, as AGENTS.md rule 1 asks for the network side.
- **Never measure in a hidden tab.** IntersectionObserver and requestAnimationFrame pause there, which already produced one misleading GenClass demo result; scroll-reveal, layout-shift and animation checks are the most exposed.

## Gaps

- No training was run from this document. vision/ on this branch applies the after-load Chromium recipes to crawled pages; the other phases (before-load, network, init, on-interaction) still need a harness (VISUAL.md section 15 sketches `bench/visual/faults.mjs`).
- The vision validation run exercised 99 of the then 122 after-load recipes on real pages (one threw). The 53 recipes added in the gap merge were only syntax-checked, and the HTML rewrites run once against stub helpers; none has run in a browser. Each needs a dry run on the demos, templates and compat apps to confirm that it applies, that the fault is visible in the stated env, and that controls stay quiet.
- The gap merge added env keys (forcedColors, media, keyboard) and harness helpers (click, tap, byText, inAppLink, inAppRoutes, gotoDirect, cleanLoadUrls, openFirstDatePicker) that injectors.json documents but no runner implements yet. Every recipe that needs them is in a phase the vision crawl does not run, so the crawl cannot apply one without its emulation; a runner that adds after-load support for these keys must skip recipes whose env it cannot apply.
- Several gap-merge recipes load third-party content (YouTube embeds, a Static Maps image, a maps iframe, a Google sample video), so their results depend on those hosts that day and they send requests from the crawler to YouTube and Google.
- The shared web-search budget (200 calls per turn) ran out in every sweep. Not covered: r/webdev, r/Frontend, r/nextjs, r/tailwindcss, r/reactjs, r/ChatGPTCoding and r/ClaudeCode (r/ClaudeCode only through titles for one entry); Reddit comments (posts only); Discord (Lovable, Bolt, v0); Indie Hackers (403); X, LinkedIn and YouTube beyond search snippets; Product Hunt comments; Smashing Magazine and CSS-Tricks mistake lists except through secondary pages; the State of CSS pain-point rankings.
- The corpus study's scripts, repo lists and URL liveness data, and those of the gap review's re-scan, live only in the session scratchpad. The two passes counted 375 and 377 repos (clones differ between runs); each figure gives the denominator it used. Committing them (small text files, under 1 MB without the cloned corpus) would make the corpus numbers reproducible.
- Thin families: Alignment, spacing and consistency (design quality, mostly benchmark scores, no defect rates); Dark mode beyond the half-applied case (no AI-specific rate; SUD is Android); Motion and shift beyond scroll reveal, layout shift and route scroll position (scroll jank and late-CSS flashes rest on comments and issues; scroll-hijacking libraries are in 2% of repos); Template and data leaks beyond placeholders and raw markdown (mojibake has 2 posts and none in a source scan, template leaks have no AI-specific rate).
- Thin within families: video (`video-failed`, a static count), CSP blocks (`csp-blocked`, no failure found), print (`export-render-broken`), forced-colors mode (`forced-colors-focus-lost`, rendered only under Chromium emulation), canvas and WebGL apps (`webgl-canvas-blank`, exposure only) and Bootstrap (`bootstrap-version-mix`, a web-wide count) now have entries with little evidence. Still not covered: email templates and framework stacks other than React, Tailwind, shadcn and Bootstrap (Vue, Svelte, Angular Material, CSS-in-JS).
- No AI-specific contrast figure: WebAIM and the Web Almanac are web-wide, and [Suh] found GPT-4o had fewer contrast issues than human code. A contrast scan of the Corpus apps rendered in a browser would settle it.
- Most rates are static (repo regexes) or come from single audits ([Harvv], [DWC]). Rendering a sample of the Corpus apps and running the detectors would turn exposure numbers into observed defect rates; that needs the owner's OK for the compute. The gap review's additions lean on exposure too: `route-scroll-kept`, `spa-deep-link-404`, `stale-chunk-blank`, `llm-markdown-raw`, `webgl-canvas-blank` and `theme-flash` are source patterns that fail under a condition.
- Lovable commit counts are keyword matches with stemming; only samples were read. v0 and bolt commits are authored by users, so there is no equivalent signal for them.
- Liveness of placeholder hosts changes month to month (via.placeholder.com went down and came back in 2026); the dead-host numbers are a one-day snapshot.
