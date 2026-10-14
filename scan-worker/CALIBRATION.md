# Calibration of scan-score/3

The deeper checks and the new score, run on a fixed reference set of public home pages and the deliberate-bug fixture,
with sampled findings checked by hand against the live page. 2026-10-14, the test copy
(`genclass-scan-test.mehar-144.workers.dev`, wrangler env `test`), Chrome 128.0.6613.137 in Cloudflare Browser
Rendering, axe-core 4.13.0, report version 6.

## What was scanned

20 public home pages chosen before any scan, and the fixture (`?deep=1`, one deliberate problem per check):

- 14 well-known sites across kinds: a reference site, a developer platform, two government sites, a company site,
  developer documentation, a university, a personal static site, two publishers, a nonprofit, a marketplace, a search
  engine and an online store;
- 6 sites made with an AI app builder, taken from that builder's public community showcase.

Sites are named here by letter only (A to T; X is the fixture). One load per site per pass, one site at a time, 20 s
apart, through the public `POST /api/scan` of the test copy, so the rate limits and robots.txt rules applied as for any
visitor. Pass 1 with the first build, pass 2 after the first round of fixes, pass 3 after the second round (stopped
after five sites, when site E showed that its fix for row 7 below was incomplete), and pass 4 on the final build (the
tables below). Besides the passes, a few single scans were made to diagnose a finding (C twice, J twice, E once)
and the pass-4 rescans described below; 86 scans in all over the day, about 4 per page.

## How findings were checked

For pass 2 and pass 4, three findings per site were picked at random with a fixed seed (a hash of the site's letter and
the finding's number, so the pick is reproducible and not chosen by hand); a site with three or fewer findings had all of
them checked. Each pick was checked in a desktop Chrome on a home connection, at the view's size (1366 by 768, or 390 by
844 and 320 wide with a phone user agent), by reading the DOM and computed styles of the named element (contrast from the
computed colours, sizes from `getBoundingClientRect`, ARIA attributes, landmark structure, scroll widths, natural image
sizes and transfer sizes from Resource Timing) or, for timings, with the same PerformanceObserver reads the scanner makes.
A finding counts as real when the live page shows what the finding measured, against the standard it names.

## The final pass (pass 4)

Scores out of 100; "n/m" is not measured (left out of the overall score, with the reason in the report). Pass 4's pages
A and B were scanned again after the last two LCP and image-dimension fixes, and pages H, I, J, L, O, Q, R and X after
the logotype fix (each of those fixes can only remove or downgrade a finding of its rule, so pages without one were not
affected). Site K's first pass-4 scan did not finish within the 150 s the calibration client waits (the scanner's own
budget is 50 s); its rescan finished in 26.5 s. The cause is not known.

| site | kind | s | overall | visual | a11y | phone | reliab. | speed | races | scored findings (rules) | not scored | pass 1 overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | reference | 19 | 89 | 100 | 55 | 100 | 100 | 100 | 100 | 4 (4) | 0 | 80 |
| B | developer platform | 29 | 99 | 100 | 97 | 100 | 100 | 100 | n/m | 1 (1) | 0 | 99 |
| C | government | 24 | 99 | 100 | 96 | 100 | 100 | 100 | 100 | 1 (1) | 1 | 99 |
| D | company | 23 | 99 | 100 | 97 | 100 | 100 | 100 | 100 | 1 (1) | 0 | 91 |
| E | documentation | 16 | 91 | 100 | 89 | 72 | 100 | 100 | n/m | 4 (4) | 0 | 87 |
| F | education | 19 | 86 | 100 | 68 | 71 | 100 | 100 | n/m | 3 (3) | 0 | 86 |
| G | personal, static | 43 | 73 | 100 | 11 | 85 | 97 | 100 | n/m | 9 (9) | 0 | 99 |
| H | publisher | 27 | 87 | 100 | 48 | 100 | 97 | 100 | 100 | 7 (7) | 1 | 79 |
| I | nonprofit | 17 | 78 | 100 | 30 | 80 | 100 | 100 | n/m | 9 (9) | 0 | 78 |
| J | marketplace | 30 | 86 | 100 | 49 | 100 | 100 | 93 | 100 | 7 (7) | 1 | 86 |
| K | government | 25 | 92 | 100 | 70 | 100 | 100 | 100 | 100 | 4 (4) | 1 | 92 |
| L | search | 26 | 84 | 100 | 37 | 100 | 100 | 96 | 100 | 8 (8) | 0 | 84 |
| M | publisher | 42 | 77 | 100 | 31 | n/m | 100 | 100 | n/m | 7 (7) | 2 | 99 |
| N | retail | 40 | 85 | 100 | 49 | 90 | 100 | 100 | 85 | 6 (6) | 1 | 84 |
| O | AI builder | 23 | 89 | 100 | 70 | 88 | 100 | 97 | n/m | 4 (4) | 0 | 89 |
| P | AI builder | 20 | 96 | 100 | 88 | 100 | 100 | 97 | n/m | 5 (5) | 0 | 96 |
| Q | AI builder | 27 | 91 | 100 | 66 | 100 | 100 | 100 | n/m | 4 (4) | 1 | 91 |
| R | AI builder | 17 | 82 | 100 | 51 | 85 | 100 | n/m | n/m | 3 (3) | 1 | 84 |
| S | AI builder | 17 | 81 | 100 | 40 | 86 | 100 | 100 | n/m | 3 (3) | 1 | 81 |
| T | AI builder | 37 | 99 | n/m | 97 | 100 | 100 | n/m | n/m | 1 (1) | 1 | 99 |
| X | the fixture, `?deep=1` | 31 | 57 | 52 | 40 | 53 | 65 | 90 | 85 | 19 (19) | 0 | 57 |

| | min / median / max over the 20 public pages, pass 4 | pass 2 | pass 1 |
|---|---|---|---|
| overall | 73 / 88 / 99 | 73 / 87 / 99 | 78 / 88 / 99 |
| visual | 100 / 100 / 100 (19 measured) | 100 / 100 / 100 (19) | 70 / 100 / 100 (19) |
| accessibility | 11 / 60.5 / 97 (20) | 11 / 62 / 97 (20) | 30 / 67 / 97 (18) |
| phone | 71 / 100 / 100 (19) | 71 / 98 / 100 (20) | 70 / 98 / 100 (18) |
| reliability | 97 / 100 / 100 (20) | 97 / 100 / 100 (20) | 97 / 100 / 100 (20) |
| speed | 93 / 100 / 100 (18) | 93 / 100 / 100 (19) | 90 / 100 / 100 (19) |
| races | 85 / 100 / 100 (8) | 85 / 100 / 100 (8) | 85 / 100 / 100 (8) |

No public page scored 100. Pass 1's 99 for G and M came from Accessibility not being measured there (no time left for
axe-core); once it was, they scored 73 and 77. Races is measured only where the probe had a search box or a posting form
(8 of 20). T's visual checks and timings could not be read in any pass (its main thread stayed busy, retrying requests the
scanner had answered with stand-in replies), M ran out of time for the phone audits in pass 4, and R's desktop timings
could not be read in its pass-4 rescan; each report says so.

The fixture: every deliberate problem of `?deep=1` was reported in pass 4 (text at 1.08:1, `$NaN`, the 404 stylesheet and
image, the unnamed button, the image without alt, text at 2.85:1, content outside landmarks, the four 16 px targets,
`maximum-scale=1`, 10 px text, the 340 px box at 360 and 320 px, mixed content, the 404 script, the TypeError, the
console.error, the 1.4 MB image shown at 80 by 60, the late image without dimensions, the double submit), except Largest
Contentful Paint: its late image arrives after about 1.5 s and the phone load painted it at 1.9 s, within 2.5 s, so no
finding is right. `?deep=1&slow=1` (the image 4.5 s late) gave LCP 9.30 s and 9.40 s, poor.

## The sampled checks, pass 4

| site | checked (seeded pick of 3) | result |
|---|---|---|
| A | link-in-text-block, aria-allowed-role, region | 2 real (link at 1.33:1 to its text, no underline; checkbox with role button and no aria-pressed); 1 unconfirmed (the region named a banner that did not appear in the check's load) |
| B | landmark-unique (the only finding) | real (two form landmarks with the same label) |
| C | region, CLS (not scored) | region real by axe-core's rule (a cookie-banner link comes before the skip link, so axe does not treat it as one); CLS not reproduced, listed not scored (row 3) |
| D | empty-heading (the only finding) | real (an empty `h4`) |
| E | region, landmark-one-main, tap-target-small | 2 real (no `main`; a 324 by 19 px link 11 px from the next one); 1 unconfirmed (region names the skip-link list, whose targets exist in a desktop browser) |
| F | aria-allowed-attr, heading-order, tap-target-small | 3 real (`aria-expanded` on a plain text input; `h1` then `h4`; footer links 16 px tall, centres 23.05 px apart) |
| G | html-has-lang, region, page-overflow-x | 3 real (no `lang`; a table layout without landmarks; a table making the phone page 430 px wide) |
| H | color-contrast, list, landmark-unique | 3 real (#d33a2c on #ffe7e7 at 16 px bold; `li role="none"` in each list; two unlabelled top-level headers) |
| I | region, landmark-one-main, page-has-heading-one | 3 real (a banner outside landmarks; no `main`; both `h1` empty) |
| J | color-contrast, html-has-lang, lcp-slow | 2 real (#009900 on white at 19 px, 3.78:1; no `lang`); LCP unconfirmed (row 10's note) |
| K | role-img-alt, landmark-unique, page-has-heading-one | 3 real (role img with an empty label; unlabelled duplicate navigation and search landmarks; no `h1`) |
| L | aria-valid-attr-value, aria-allowed-role, heading-order | 3 real (`aria-controls` naming a panel that does not exist; `textarea` with role combobox; `h3` then `h6`) |
| M | button-name, list, region | 3 real (a play button containing only an SVG; list items with role group; a topics list outside landmarks) |
| N | region, reflow-overflow, js-error (not scored) | 2 real (a promotion bar outside landmarks; the page 326 px wide at 320); the error is listed not scored (stand-in answers) |
| O | color-contrast, reflow-overflow, lcp-slow | 3 real (#fcfcfc on #dd385b at 14 px, 4.28:1; 341 px wide at 320; LCP 6.2 s in a desktop browser) |
| P | landmark-main-is-top-level, landmark-unique, lcp-slow | 3 real (a `main` inside a `main`; two unlabelled `main`s; LCP 3.9 s in a desktop browser) |
| Q | color-contrast, landmark-main-is-top-level, landmark-unique | 3 real (#5dbf94 on #295441 at 11 px, 3.83:1; a `main` inside `main#main`) |
| R | button-name, zoom-disabled, console-error (not scored) | 2 real (a 256 px button with no name; `user-scalable=no, maximum-scale=1.0`); the message is listed not scored |
| S | button-name, reflow-overflow, js-error (not scored) | 2 real (37 unnamed grid buttons; 358 px wide at 320); the error is listed not scored |
| T | region, image-oversized (not scored) | 2 real (a cookie notice outside landmarks; 2048 by 2048 files drawn at 24 by 24, not scored because Speed was not measured there) |

54 findings checked on the public pages: 46 scored findings confirmed, 3 scored findings unconfirmed (two minor
best-practice `region` findings that name banners or skip links that did not reproduce, and one LCP), none found false,
and 5 findings that are listed but not scored. The sampled checks of pass 2 (and the reading of passes 1 to 3) found the
false findings in the next section, each fixed before pass 4.

## False findings found, and what was done

Each one was found in the sampled checks above or while reading the reports, confirmed against the live page, and fixed
in the scanner; nothing was fixed by changing a weight.

| # | where | what the scanner reported | what the live page showed | fix |
|---|---|---|---|---|
| 1 | A, phone | tap targets: menu links 0 px from each other | the links belong to a menu kept behind the page (covered by the content, not hidden by CSS) | every target is hit-tested at its centre, half a screen at a time; covered targets are left out |
| 2 | J, desktop | Cumulative Layout Shift 1.16 (one shift of 1.00 with no element) | CLS 0.006 at 1366 px | layout shift is listed, not scored (below) |
| 3 | C, desktop | CLS 0.24 (the header moved at 0.4 to 1.0 s) | no shift at 1366 px; the scanner's own number repeated exactly on a rescan, and also without the GenClass runtime in the view (a diagnostic deploy of the test copy) | layout shift is listed, not scored |
| 4 | A, phone | the visual checks' layout shift 0.63 | no shift at 390 px | layout shift is listed, not scored |
| 5 | H, all views | the visual checks: "the page cannot scroll" (body has overflow-y: hidden), critical | html has overflow-y: scroll, so the window scrolls; it scrolled 600 px | a scroll lock blamed on body is left out when html's overflow-y is scroll or auto and there is content to scroll to (CSS overflow propagation); noted for the runtime's check |
| 6 | D, all views | color-contrast on text at 10 px; text under 12 px | the text is a mock interface inside product illustrations marked `role="img"` and `aria-hidden="true"` | color-contrast and the text-size audit leave out text inside `role="img"` or `aria-hidden="true"` (WCAG 1.4.3's incidental text: part of a picture, or decoration) |
| 7 | E, desktop | link-in-text-block: a link with no underline | the link is underlined; the page removes the underline on `:focus` and `:hover`, and the scanner had left focus (its Tab presses) or the pointer (its scrolling) on it | before axe-core and the audits run, focus is cleared and the pointer leaves the page; clearing focus alone did not remove the finding in pass 3, moving the pointer off did |
| 8 | N, race probe | a double click sent the same request twice | the two identical POSTs went to an advertising network's tracking endpoint, not the site | the probe counts a double submit on the site's own requests only |
| 9 | A, desktop | an image without dimensions moved content: the logo loaded at 0.32 s, a shift at 0.98 s | the logo is sized by an inline style (`width: 8.75em; height: 1.375em`) and arrived at 403 ms, before the first paint at 600 ms, so it cannot have moved anything | an image sized by inline style counts as sized; it must arrive after the first paint; the shift must come within 500 ms of it (was 1.5 s) |
| 11 | J, desktop and phone | color-contrast, its first element lavender text on white | the text is the site's own name drawn as a 110 px watermark (#e6e6fa on white); WCAG 1.4.3 exempts logotypes | color-contrast leaves out text that is only the site's own name (its domain's label) |

Layout shift, in detail: on the three public pages where the scanner measured a shift (2, 3 and 4), a desktop browser
loading the same page measured none, while the fixture's deliberate late image was measured correctly in every pass.
Turning the GenClass runtime off in the desktop view did not change the scanner's number (3). The likely cause is the
scanner itself: every request waits for its checks before it continues, so content that scripts add after the first
paint (a cookie banner, a fundraising banner) moves the page more than it does for most visitors. Both the scanner's
CLS and the visual checks' `layout-shift` are therefore listed with what was measured and not scored. Images without
dimensions that the scanner saw push content down stay scored, always minor: the missing width and height are a defect
whatever the size of the shift.

Two changes that are not false findings but came from the same runs:

- The desktop window was 780 by 580 px on an 800 by 600 screen while the viewport was 1366 by 768, which a page can read
  from `window.outerWidth` and `screen`. The desktop window and screen are now sized to the viewport, as phone emulation
  already does. It did not change site J's layout in the scanner, which still differs from a desktop browser's.
- Two slow pages (G, M) left no time for axe-core in pass 1, so Accessibility was "not measured". Navigation is now
  capped at 16 s instead of 20, and a page whose load event timed out gets half a second, not 4, for its network to go
  quiet. Both were measured in passes 2 and 3.

## Timings

Largest Contentful Paint from the scanner's desktop view against a desktop browser on a home connection, same page,
same size, once each: site D 2.6 s against 4.3 s, site O 3.2 s against 6.2 s, site N 3.5 s against 6.7 s, site J 3.4 s
against 2.4 s, site B 2.64 s (pass 4) against 0.59 s. For image-led pages the scanner was faster than the home
connection; for B, a heading painted in a web font, it was more than four times slower (it measured 1.49 s for the same
page in pass 2). So one load in the scanner can be wrong in either direction, which led to row 10:

| # | where | what the scanner reported | what the live page showed | fix |
|---|---|---|---|---|
| 10 | B, desktop | Largest Contentful Paint 2.64 s, needs improvement | 0.59 s in a desktop browser; the scanner's own light phone view measured 2.13 s on the same scan | LCP is judged on the faster of the two loads in the same browser (the desktop view and the light phone, which loads without GenClass); no finding when that is within 2.5 s, and the finding names both |

With that rule, across passes 1, 2 and 4 the LCP findings that remain are on pages a desktop browser also measured as
slow (N, O; K in pass 2), plus J (2.86 s and 3.01 s in pass 2, against 2.4 s in the desktop browser: not confirmed, and
J renders a different layout in the scanner, row 2). Every LCP finding says it was measured once per view in a data
center.

## Weights

The weights (Visual bugs 25, Accessibility 25, Phone 20, Reliability 15, Speed 10, Races 5), the severity points
(critical 30, serious 15, moderate 7, minor 3) and the instance factor (at most twice the base) were set before the first
scan and were not changed by the calibration, either to reach a target score or for any other reason. Every change above
fixed a false finding or a measurement. The spread across pages comes mostly from Accessibility, because axe-core finds
WCAG A and AA failures on most real pages; its weight caps what it can take from the overall score at 25 points. The
GenClass visual checks found nothing on the public pages after the scroll-lock correction (they abstain on anything they
cannot measure), so Visual bugs is 100 for every public page measured; that is a property of those checks, not of the
weights.

For comparison, the scan-score/2 runs recorded in the README: 10 of 11 public pages scored 100 and one 98; in a later
run, one page 90.

## What the owner should review

- The layout-shift decision (listed, not scored), against the requirement to score CLS with the web.dev thresholds.
- The two scanner-side corrections of the visual chunk (the phone overflow cause, now also the scroll lock on body),
  which belong in the runtime's checks.
- That pages building their content from POST requests (common for AI-builder sites using a hosted database) get the
  scanner's stand-in answers, so what axe-core and the audits see there can differ from a visitor's page (site T's
  sampled scrollable-region finding was not reproduced for that reason).

# Calibration of the model judge (Clef)

The model judge (README, "The model judge"; `src/judge.ts`) on the same reference set: the 20 public home pages A to T
above and the fixture with `?deep=1&judge=1` (X), which adds the judge's cases to the deliberate bugs: a "Start free
trial" link drawn as a white button with a white-to-near-white gradient, whose text is dark in the light scheme and
white in the dark scheme (white on white there); grey text over a busy image; and two controls, bold white text over the
same image under a dark overlay (readable) and, from pass 3, a paragraph coloured by a CSS variable defined nowhere,
which falls back to the colour around it and reads normally (the visual checks report `css-var-undefined` only when the
text becomes unreadable, so they leave it out; the judge does not ask about it either, its background being plain). The
measured checks abstain on the first three (a gradient, an image); the fixture's faint sentence (1.08:1) is the measured
finding the judge takes a second look at. 2026-10-14, the test copy, Chrome 128 in Browser Rendering,
`@cf/cloudflare/clef` on Workers AI, report version 7. Three passes, one site at a time, 20 s apart, through the public
`POST /api/scan` of the test copy, the test copy's cached reports deleted before each pass; 6 fixture scans while
building; and one fixture scan after a fixture fix in pass 3.

## How the judge's work was checked

Every finding the judge made and every measured finding it judged (kept, or listed as probably fine) was checked by
looking at the crop the model saw, and where the crop and the view's screenshot disagreed, at the screenshot too. A
finding the model made counts as right when the crop shows a problem a visitor would have (text they cannot read, a
control they cannot see or use), and a measured finding it kept or listed as fine counts as right when the crop agrees
with that. From pass 2 the test copy kept every crop and every call's text (`JUDGE_CROPS=all`), so elements below the
thresholds could be looked at too, and every crop was asked again with the other prompt through the evaluation's private
worker (the same model; `vision/clef/worker`), so the two prompts were compared on the same inputs.

## Pass 1: every element with the facts and the caution (`clef-img-p3`), keep 0.9777, own findings 0.9843

21 scans, 297 calls, all answered within 4 s. The model made 4 findings: three on site N (two buttons and a heading over
photos, further down the page) and the fixture's readable control text. All 4 were wrong: N's crops were blank where the
view's screenshot shows the buttons and heading clearly, and the fixture's crop for the readable text showed the faint
sentence instead. It kept the fixture's faint text (1.08:1), the right decision, but on the crop of the readable text.

The cause was the scanner's: the crops of one group were captured with concurrent `Page.captureScreenshot` calls, and
Chrome applied the clips across requests (the fixture's two crops came back exactly swapped, 121 px apart). Every
judgement of pass 1 on a group of more than one element is therefore void.

| # | change | why |
|---|---|---|
| 1 | crops are captured one at a time, each call sent as soon as its crop is taken; a test checks that no two captures overlap | the swapped crops above |
| 2 | a group waits (at most 0.6 s) until no finite animation runs on its elements or their ancestors before it is measured and cropped | a precaution for pages that fade content in as it scrolls into view; first written as "first screen only" from N's blank crops, withdrawn when those turned out to be swapped crops |

## Pass 2: the same prompt, crops one at a time, every crop kept

21 scans, 309 calls, all answered within 4 s. With the facts and the caution the model made no finding of its own, on
any page, and kept the fixture's faint text in both phone views (right: the crop shows white text on white). It listed
nothing as probably fine: on the public pages the visual checks reported only one sideways-scrolling page and one layout
shift, which the judge leaves as measured, so the second stage had only the fixture to work on.

It missed both of the fixture's deliberate bugs it was meant to find: the white-on-white button in the dark view scored
0.75 and the text over the busy image 0.94 to 0.96 (the threshold is 0.9843). The button's facts say why: its own
background is a transparent gradient, so the ancestor background is the dark section around it, and the facts report a
contrast of 17.6:1 for text the crop shows as white on white. For an element the measured checks abstain on, the facts
are exactly the measurements they could not make.

Asked again with the evaluation's image + tag only prompt (`clef-imgonly-p2`), at that prompt's own dev threshold for
precision at least 0.8 (0.9757), the same crops gave 4 findings: the fixture's dark button (0.984) and busy-image text
(0.976), both right; an email field's placeholder "you@example.com" in the fixture's dark view, which the model called a
leak (wrong: a placeholder in an empty field), and a header link on site G whose image is the site's name in faint grey
(wrong by the scanner's own rule: WCAG 1.4.3 exempts logotypes, and axe-core's `color-contrast` here leaves them out).
The highest-scored public elements under it, readable links on site C, scored 0.959 to 0.974, under the threshold.

On the evaluation's labelled crops the same comparison, for the crops no rule had flagged (the judge's own findings are
of that kind), favours image + tag only on the dev split (AP 0.129 against 0.120, 6 real) and on the report split (0.420
against 0.207; at the thresholds above, 5 of 5 right against 1 of 3). A third prompt, the facts without the contrast
sentences whose background is unknown, was also run on the labelled crops (it changes 303 of the 1,856 prompts) and
rejected: dev AP 0.450 against 0.488.

| # | change | why |
|---|---|---|
| 3 | elements the measured checks abstain on are asked with the image and the tag only (`clef-imgonly-p2`); their findings start at 0.9757, that prompt's lowest dev threshold with precision at least 0.8 (4 of 4 on dev; 32 of 36 on the report split). Measured findings keep `clef-img-p3` and 0.9777 | the fixture's two misses above, and the evaluation's numbers for crops no rule had flagged |
| 4 | the dark view's class is buttons and links, as specified, not form fields | the placeholder read as a leak |
| 5 | an element whose text, or image alt or label, is only the site's own name is not asked about | the logotype on G |

No change was made to the keep threshold, to the questions or to the facts prompt itself.

## Pass 3: the final build (changes 1 to 5)

21 scans, 309 calls, all answered within 4 s (the slowest in 0.93 s), no timeouts, no failures. "s" is the whole scan;
"skipped" and "ran out" count views that had too little time left for the judge or ran out of it part way (the
elements it did not see stand as measured).

| site | s | calls (desktop / phone / dark) | answered in 4 s | kept | listed as fine | own findings | slowest view's prep, s | input tokens | USD |
|---|---|---|---|---|---|---|---|---|---|
| A | 33.0 | 17 (3 / 1 / 13) | 17 | 0 | 0 | 0 | 2.5 | 16,425 | 0.0039 |
| B | 43.1 | 1 (0 / 1 / 0), 1 skipped, 2 ran out | 1 | 0 | 0 | 0 | 2.6 | 954 | 0.0002 |
| C | 27.4 | 13 (0 / 0 / 13) | 13 | 0 | 0 | 0 | 1.3 | 12,508 | 0.0030 |
| D | 31.3 | 15 (3 / 1 / 11) | 15 | 0 | 0 | 0 | 2.5 | 14,839 | 0.0036 |
| E | 28.2 | 13 (0 / 0 / 13) | 13 | 0 | 0 | 0 | 2.4 | 12,508 | 0.0030 |
| F | 28.1 | 28 (12 / 3 / 13) | 28 | 0 | 0 | 0 | 2.4 | 27,005 | 0.0065 |
| G | 23.4 | 23 (1 / 0 / 22) | 23 | 0 | 0 | 0 | 3.2 | 22,219 | 0.0053 |
| H | 24.4 | 22 (6 / 3 / 13) | 22 | 0 | 0 | 0 | 1.1 | 21,182 | 0.0051 |
| I | 26.9 | 15 (2 / 0 / 13) | 15 | 0 | 0 | 0 | 2.3 | 14,522 | 0.0035 |
| J | 41.0 | 15 (0 / 2 / 13) | 15 | 0 | 0 | 0 | 2.9 | 14,415 | 0.0035 |
| K | 45.9 | 17 (2 / 2 / 13) | 17 | 0 | 0 | 0 | 2.7 | 16,326 | 0.0039 |
| L | 31.2 | 4 (0 / 0 / 4) | 4 | 0 | 0 | 0 | 0.6 | 3,827 | 0.0009 |
| M | 45.6 | 2 (1 / 0 / 1), 1 skipped, 1 ran out | 2 | 0 | 0 | 0 | 1.7 | 1,918 | 0.0005 |
| N | 43.8 | 30 (5 / 6 / 19) | 30 | 0 | 0 | 0 | 1.8 | 28,883 | 0.0069 |
| O | 21.7 | 11 (6 / 0 / 5) | 11 | 0 | 0 | 0 | 0.8 | 10,581 | 0.0025 |
| P | 34.0 | 14 (4 / 4 / 6), 1 ran out | 14 | 0 | 0 | 0 | 3.6 | 13,463 | 0.0032 |
| Q | 30.2 | 22 (7 / 0 / 15) | 22 | 0 | 0 | 0 | 2.6 | 21,147 | 0.0051 |
| R | 16.4 | 15 (8 / 0 / 7) | 15 | 0 | 0 | 0 | 0.7 | 14,566 | 0.0035 |
| S | 30.8 | 16 (0 / 3 / 13) | 16 | 0 | 0 | 0 | 2.3 | 15,358 | 0.0037 |
| T | 42.1 | 0 (0 / 0 / 0), 2 skipped | 0 | 0 | 0 | 0 | 1.3 | 0 | 0.0000 |
| X | 32.4 | 16 (3 / 3 / 10) | 16 | 0 | 0 | 1 | 1.2 | 15,398 | 0.0037 |
| X, fixed | 31.4 | 19 (4 / 4 / 11) | 19 | 1 | 0 | 1 | 0.8 | 19,309 | 0.0046 |

The judge's work, each checked on its crop:

- **Its own findings: 1 right, 0 wrong.** The fixture's white-on-white button in the dark view (0.9815; 0.9773 after the
  fixture fix below); the crop shows white text on a white button. None on the 20 public pages.
- **Measured findings kept: 1 right, 0 wrong; listed as probably fine: none.** The 20 public pages had no visual finding
  at all in this pass, so the second stage had nothing to do there. On the fixture it had nothing either, at first: the
  judge's cases, put above the faint sentence, pushed it down under the page's fixed chat bar, where the visual checks
  leave it out (the text is covered; that is also why passes 1 and 2 had it in the phone views only: on the desktop the
  cases pushed it under the bar). The fixture now puts the cases after it; the scan after that fix ("X, fixed")
  reported the faint sentence in all three views and the judge kept it in all three (0.988 to 0.993), right: the crops
  show near-white text on white.
- **Misses: 1, and 1 arguable.** The fixture's grey text over the busy image scored 0.947 to 0.973 in the three views,
  under 0.9757 each time (in pass 2's image + tag only re-ask it scored 0.976): the crop shows text hard to make out
  over a busy picture. And a small faint grey copyright line on site G, on a background the measured checks could not
  read, 0.9714. The bold white text over the same image under a dark overlay scored 0.74 to 0.80, right.
- **Near misses.** 42 of the 293 public calls scored 0.95 or more, none at the threshold. The 18 highest, 0.963 to
  0.974, were readable links, headlines, buttons and navigation pills in the dark view (sites C, D, H, I, J, N, R), two
  empty slots of a logo carousel (D, 0.9705, "blank"), the copyright line above, and one crop of a link on E that is all
  dark (0.9658, "blank"; the crop does not show what it holds). A crop the model calls "unreadable" or "cut off" at 0.97
  is mostly fine.

No change was made after pass 3. The busy-image miss would need a threshold under 0.9725, which would also take in the
readable links at 0.9726 to 0.9739, so the threshold stays at the evaluation's dev point.

### Fixture fix

| # | change | why |
|---|---|---|
| 6 | the fixture's judge cases come after the faint sentence, not before it (`test/fixture/worker.js`); no change to the judge | the faint sentence under the chat bar, above |

### Time and cost

| | median | p95 | max |
|---|---|---|---|
| whole scan, s (budget 50; none over) | 31.2 | 45.6 | 45.9 |
| the judge's part of the views, s (finding, measuring, cropping, sending; the answers come while the probe and the guard pass run) | 0.9 | 2.4 | 3.0 |
| finding, measuring and cropping, per view, s | 1.1 | 2.9 | 3.6 |
| one call, ms (median of each scan's median; slowest call) | 308 | | 933 |
| first call sent to last answer, s | 2.6 | | 5.4 |
| calls a scan | 15 | | 30 |
| input tokens a scan | 14,566 | | 28,883 |
| USD a scan, at $0.24 per million input tokens (Workers AI pricing, 2026-10-14) | 0.0035 (mean 0.0034) | | 0.0069 |

965 tokens a call on average (the image + tag only text is shorter than the facts). At the cap, 40 calls of the
largest crops, about $0.0125 a scan. In pass 2, with the facts for every element, a scan cost $0.0045 on average and at
most $0.0096. Four views had too little time left for the judge (sites B, M, T) and four ran out part way (B, M, P);
these are the pages whose loads and deeper checks take longest, and the scan stayed within its budget each time.

## What the owner should review before production

- **The prompt for the judge's own findings is not the evaluation's dev choice.** Elements the measured checks abstain
  on are asked with `clef-imgonly-p2` (image and tag only), the evaluation's second prompt, chosen here from the
  fixture's two misses and the evaluation's numbers for crops no rule had flagged (thin on dev: 6 real). The evaluation
  itself left the choice between the two open and recommended a fresh labelled batch; that is still how to settle it.
- **The thresholds sit where the scores crowd near 1.** 0.9757 for its own findings rests on 4 dev crops (4 real); the
  highest-scored ordinary elements on the public pages scored 0.963 to 0.974, a few thousandths under it, and the
  fixture's busy-image text 0.9725. A model update or a change in how crops are cut can move many elements across.
- **Its precision on real pages is unmeasured.** In the final pass it made no finding on any of the 20 public pages, and
  the second stage never ran on a public page (they had no measured visual finding); the numbers it publishes are the
  evaluation's, measured against labels that six AI labeller agents made, not people.
- **Privacy text.** Crops (with whatever text the page shows in them) go to Workers AI. `/scan/about` and the page
  footer say so; genclass.dev's own `/privacy` page does not mention the page check at all.
- **What a page can do to it.** Text inside a crop can talk to the model. The most a page can do is list its own
  measured visual findings as probably fine (shown, not scored) or add moderate Visual findings to its own report.
- **Possible double counting.** A dark-view button on a solid background whose contrast axe-core also fails would be an
  Accessibility finding and, if the model scores it, a Visual one. Not seen in calibration.
- **Load.** At `MAX_CONCURRENT` 10, up to about 400 calls a minute; Workers AI does not publish Clef's rate limit. The
  account's free 10,000 neurons a day cover about 24 scans at the calibration's median use (15 calls) and 9 at the cap
  of 40; after that, list price.
- **Config.** Production's `wrangler.jsonc` has the `AI` binding and `JUDGE` on; `JUDGE_CROPS` is only in env `test` and
  must stay out of production (it keeps every crop and each call's text). `REPORT_VERSION` 7 makes every cached report
  stale once.
