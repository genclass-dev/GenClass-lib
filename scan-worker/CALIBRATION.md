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
tables below).

## How findings were checked

For pass 2 and pass 4, three findings per site were picked at random with a fixed seed (a hash of the site's letter and
the finding's number, so the pick is reproducible and not chosen by hand); a site with three or fewer findings had all of
them checked. Each pick was checked in a desktop Chrome on a home connection, at the view's size (1366 by 768, or 390 by
844 and 320 wide with a phone user agent), by reading the DOM and computed styles of the named element (contrast from the
computed colours, sizes from `getBoundingClientRect`, ARIA attributes, landmark structure, scroll widths, natural image
sizes and transfer sizes from Resource Timing) or, for timings, with the same PerformanceObserver reads the scanner makes.
A finding counts as real when the live page shows what the finding measured, against the standard it names.

FINAL_TABLES

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

Largest Contentful Paint from the scanner against a desktop browser on a home connection, same page, same size, once:
site D 2.6 s against 4.3 s, site O 3.2 s against 6.2 s, site N 3.5 s against 6.7 s, site J 3.4 s against 2.4 s. The
scanner was faster on three of four pages, so its LCP is not inflated in general; it is one load in a data center, and
every LCP finding says so. J's 2.86 s in pass 2 ("needs improvement") was not confirmed by the 2.4 s measured in the
desktop browser; J also renders a different layout in the scanner (row 2 above). The light phone's LCP is recorded next
to the desktop's in each report (`metrics.phoneLcpMs`) for comparison and not scored.

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
