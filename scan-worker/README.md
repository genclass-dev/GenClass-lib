# genclass-scan: the genclass.dev page check

Type an address, and a Cloudflare browser loads that one page as a desktop and a phone, light and dark, and checks it six
ways: the measured visual checks built for the GenClass runtime (23 kinds, 22 of them run here; in testing on
`wave2/visual`, not in any released runtime: npm's 0.2.1, main and release/0.3.0 have no visual code), axe-core 4.13.0's
WCAG 2.2 A and AA rules and best practices in every view, phone audits (WCAG 2.5.8 tap targets, WCAG 1.4.4 zoom, the
viewport meta tag, 12 px text, WCAG 1.4.10 reflow at 360 and 320 px), the browser's own record of errors and failed
requests, speed (Largest Contentful Paint, oversized and unsized images), and races: it types into the search box and
double-clicks a submit button with GenClass 0.2.1 watching. The page shows an overall score, six category scores and the
top issues, then screenshots with numbered boxes and every finding grouped by category and rule, with what was measured,
the standard it is judged by (with its link), the element, the suggested fix, and whether GenClass fixed it in the page
(measured by a re-check) or reports it for the developer. A model, Cloudflare's Clef on Workers AI, takes a second look
at crops of the screenshots (below, "The model judge"): what it decides is labelled as judged by a model, never as
measured.

- **Test copy:** `https://genclass-scan-test.mehar-144.workers.dev/scan` (wrangler env `test`: workers.dev only, no
  routes, its own bucket prefix `scan-test/` and rate-limit counters; `npm run deploy:test`). The production worker,
  `genclass-scan`, also answers on `https://genclass-scan.mehar-144.workers.dev`; this branch has not been deployed to it.
- **Routes it will own on genclass.dev** (not live; the owner adds them after review): `genclass.dev/api/scan*` and
  `genclass.dev/scan*`. The more specific `/api/scan*` route wins over the telemetry worker's `genclass.dev/api/*`.
  The trailing `*` is needed: Workers route matching includes the query string, so `genclass.dev/scan` alone would
  not match `/scan?url=…`. It also matches the site's own files that start with `/scan`, such as `/scan-box.js` (the
  home page's scan box on wave2/site-launch): this worker answers only `/scan`, `/scan/` and `/scan/about` and hands
  every other `/scan…` path to the site worker over the service binding `SITE` (`genclass-site`). Renaming the site's
  asset outside `/scan` (for example `/visual-scan.js`) removes the overlap altogether.
- **genclass.dev/&lt;url&gt;** (`genclass.dev/example.com`, `genclass.dev/https://example.com/pricing`): the site worker
  hands a path to this worker as `/scan?url=<path>` over the service binding `SCAN`, only when no page or asset answered
  (404), for GET/HEAD, when the path is URL-safe and starts with `http(s):` or is a hostname with an IANA TLD
  (`site/src/scan-path.js`, tested against every published file in `site/check/scan-path.test.mjs`). A bare name whose
  TLD is mostly seen as a file extension (`README.md`, `backup.zip`, `install.sh`, `setup.py`, `clip.mov`, `Main.java`)
  stays a 404 unless it has a path or a scheme (`genclass.dev/bun.sh/`, `genclass.dev/https://bun.sh`); `.io`, `.ai`,
  `.so`, `.app` and `.pl` stay addresses. This worker answers the same path form itself on workers.dev. Loading the page
  starts the scan, except in browsers that report automation or a crawler user agent, which must press the button.

## Routes

| route | what |
|---|---|
| `GET /scan` | the URL box |
| `GET /scan?url=…` | the report page: the cached report if one is younger than 6 hours, else it starts a scan from the page |
| `GET /scan/about` | what the scanner does and never does, the user agent, limits, the score formula and weights, opt-out, retention |
| `POST /api/scan {url}` | JSON for refusals (400 address, 403 opt-out, robots or `automated` user agent, 409 same address in progress, 429 `rate` / `site-rate` / `running`, 503 busy) and cache hits (`{ ok, cached, report }`); otherwise `application/x-ndjson`: `{type:"progress",step}` lines, then `{type:"done",report}` or `{type:"error",code,message}` (codes include `private`, `opted-out`, `robots`, `cancelled`) |
| `GET /api/scan/report?url=…` | the cached report or 404 |
| `GET /api/scan/shot/<key>/<id>-<view>.jpg` | a screenshot (from R2), only while its host (R2 custom metadata) is not opted out; `<id>-<view>-j<n>.jpg` is the crop the model judge saw for one element, served the same way |
| `GET /api/scan/health` | `{ ok, ua, runtime, report, judge, prompt }`: the report version, the judge model (null when off) and its prompt |

Every HTML response has `x-robots-tag: noindex, nofollow`, a per-response CSP nonce (`default-src 'none'`, one inline
script and one inline style, fonts from Google Fonts, images from this origin and genclass.dev), no third-party
scripts, and puts all dynamic text in place with `textContent` from a `<script type="application/json">` block.

## What happens on POST /api/scan

1. **Address** (`src/target.ts`): https:// added when missing; http and https only; credentials and fragment stripped;
   default ports only; IP literals refused in every form (decimal, hex, octal, short, IPv6 incl. mapped, NAT64, 6to4),
   with the reason for private, loopback, link-local, CGNAT and metadata ranges; `localhost`, `*.local`, `*.internal`,
   `*.test` and other reserved names refused; genclass.dev and the genclass workers refused; the host needs an IANA TLD
   (`src/tlds.ts`, generated by `scripts/update-tlds.mjs`); IDNs become punycode; trailing dots dropped.
2. **Opt-out**: `scans/blocklist.json` (`{ "hosts": [...] }`, subdomains included) plus the `BLOCKLIST` variable.
3. **Cache**: a report younger than 6 hours for the same normalised URL, made by the same `REPORT_VERSION`
   (`src/report.ts`; bump it whenever the same page would give a different report), is returned as is
   (R2 `scans/reports/<key>.json`). A report from another version is a miss.
4. **Automated clients**: a crawler, link-preview or headless user agent gets 403 `automated` (it can still read a
   cached report).
5. **Rate limits**: `SCAN_LIMIT`, 5 new scans per 60 s per client (a hash of the IPv4 address, or of the /64 for IPv6,
   never stored), and `SITE_LIMIT`, 4 new scans per 60 s per site whoever asks (`siteOf` in `src/target.ts`: the
   registrable domain approximately, or the owner's label on shared hosting such as `*.github.io`, `*.vercel.app`,
   `*.workers.dev`), so query-string variants of one slow page cannot keep the scanners busy.
6. **DNS**: A and AAAA over DNS-over-HTTPS; a name that resolves into a blocked range is refused; fails closed.
7. **robots.txt**: only a group naming `GenClassScan` counts (a person asked for one page); redirects followed by hand
   and checked; a missing file allows the scan.
8. **Slots**: at most `MAX_CONCURRENT` (10) scans at once across everyone, one per address and one per client, as
   compare-and-swap leases on `scans/slots.json` that record the client hash (expire after 60 s by themselves).
   When the person who started a scan goes away (`request.signal`, compatibility flag `enable_request_signal`, or a
   cancelled stream), the scan stops at once, closes the browser, frees the slot and saves nothing.
9. **Scan** (`src/scan.ts`), 50 s hard budget (`SCAN_BUDGET_MS`; leases last 60 s), against Browser Rendering
   (`@cloudflare/puppeteer` 1.4.0):
   - three views in parallel, each in a browser window of its own (`Target.createTarget` with `newWindow`: in one
     window only the front tab is visible, and both the visual checks and the runtime treat a hidden page
     differently): desktop 1366×768 light, phone 390×844 light, phone 390×844 dark (`prefers-color-scheme`); user
     agent: a Chrome UA ending in `GenClassScan/1.0 (+https://genclass.dev/scan)`; navigation capped at 16 s, then up
     to 4 s for the page's network to go quiet (half a second after a load that timed out; the scanner's own runtime
     and model downloads do not count); the desktop window and screen are sized to the viewport (`fitDesktopWindow`:
     a new headless window is 780×580 on an 800×600 screen, which a page can read from `outerWidth` and `screen`);
   - a DevTools session of the scanner's own per view (`src/cdp.ts`), opened before navigation: uncaught errors,
     `console.error`, every response's status and size, mixed content; closed when the view's checks end;
   - at network quiet, before any key press or scroll: Largest Contentful Paint, layout shifts and images without
     dimensions (`pageSide("vitals")` in `src/audits.ts`);
   - the GenClass visual checks for about 6 s (below), with the with-GenClass re-check when fixes were applied, then a
     JPEG of the top of the page with the fixes undone, and a box for every finding;
   - then the deeper checks (`deeperChecks`), after the pointer leaves the page and focus is cleared (the visual
     checks' Tab presses and scrolling would leave `:focus` or `:hover` styles on what is judged), each only when the
     time left before the race probe allows it, each saying so when it does not (and its category is then "not
     measured", never 100): axe-core in every view; the page
     audits on the desktop and the light phone; on the light phone, last, the same page narrowed to 360 and 320 px
     without a reload for the reflow check (below);
   - then the model judge (`judgeView` in `src/scan.ts`), in the time the checks above left before the race probe's
     reserve: the elements to ask about, a crop and the measured facts of each, and the calls sent at once, answered
     while the probe and the guard pass run (below);
   - the race probe on the desktop page with `@genclass/runtime` 0.2.1 injected before any page script (observe,
     `telemetry: false`, model from `https://genclass.dev/model/@genclass/runtime-model@0.2.0/files/`): type `a`, `ab`,
     `abc` 80 ms apart into the first search-like input, then double-click the most prominent submit button of a
     same-origin form that would POST (forms with password or card fields are skipped); `rt.on("detect")` and
     `rt.on("act")` are recorded with each decision's gate and reason; if the model is not ready in time the report
     says so;
   - the same probe in a fresh page with GenClass in guard mode, waiting for the same targets.
   - the scanner's DOM code (the visual checks and the probe's target finder) runs in Puppeteer's isolated world, so
     the page's scripts cannot see or patch it; the checks are installed under a per-scan random, non-writable name,
     and only when the embedded chunk itself defined them. What the GenClass runtime reports is
     kept in the bootstrap's closure and read back through a non-writable per-scan function, so a page cannot fake a
     GenClass detection or action. Everything read back from the page is cut to size and checked
     (`sanitizeFinding`, `sanitizeNotes`, `sanitizeStats` in `src/catalog.ts`).
10. **Report** (`src/report.ts`), saved to R2 with the screenshots, streamed to the page. Nothing is saved or streamed
    when the scan was thrown away (below).

### The request policy (`src/policy.ts` and the request handler in `src/scan.ts`), in every view and phase

- No non-GET request reaches the network: POST, PUT, PATCH, DELETE and beacons get a local stand-in `200` JSON
  (`{"ok":true,"id":"scan-N","status":"ok"}`, CORS headers for the page's origin), a form navigation gets `204` so
  the page stays, preflights get `204`. Form data a page's script sends with GET does reach the site's own origin.
- Requests to blocked IP literals (private, loopback, link-local, CGNAT, metadata, every encoding) and local names are
  aborted, redirect hops included.
- **Every request to a hostname is resolved over DNS-over-HTTPS first** (cached per scan, at most 150 names): a name
  with a private answer is aborted; a name with no address is aborted and still counts as a failed stylesheet, font or
  image; a name the lookup could not answer is aborted and the view says how many were.
- A main-frame navigation other than the URL asked for (a redirect, or a script changing location while the page
  loads) must also pass the opt-out list and the target's `robots.txt` (`navigationCheck` in `src/app.ts`); one to
  genclass.dev is aborted. A refused redirect fails the scan with the refusal's code; a page that ends up on a refused
  host after load is thrown away.
- After the first load the main frame never navigates (the probe does not follow links). No new windows: the safety
  bootstrap makes `window.open` return null and points forms, submit buttons and links that would open another window
  or tab at the page itself; the probe skips such forms anyway (`probeTargets`).
- While clicking, fetch/XHR/document GETs to other origins are aborted (nothing submitted to a third party by GET).
- During the probe, fetch/XHR GETs get 0 to 1,500 ms of extra latency from a seeded sequence (longest first in a
  burst), so responses can arrive out of order. Service workers cannot register and are bypassed
  (`setBypassServiceWorker`). WebSocket connections to IP literals or local names are refused, the hosts of the others
  are resolved afterwards (a private answer throws the scan away), and WebSocket sends are held while the probe types
  and clicks.
- Remote addresses: Chrome in Browser Rendering reaches the network through a local proxy, so every response reports
  `::1` (measured on the test copy, 2026-10-13). The scanner notices that from the main document and then ignores
  response addresses; where the browser connects directly, a response from a blocked address throws the scan away.
  The remaining gap: the browser (or its proxy) resolves each name again itself, so a DNS server that answers
  differently the second time can get past the pre-check. Only GETs leave the browser.

### Stand-in answers while the page loads

A page that loads content with POST (GraphQL, storefront APIs, search services) gets the stand-in answer above, and can
render `NaN` or a broken image from it. Each view counts the non-GET fetch/XHR requests it answered while loading and
says so in a note. A template leak, a broken image or a GenClass diagnosis other than a duplicate is then listed but
not scored, when every view it appeared in had such answers (`unscored` on the finding).

## The visual checks: the runtime's own chunk

The checks are the measured visual checks built for the GenClass runtime (`packages/runtime/src/visual`, branch
`wave2/visual`, docs/runtime/VISUAL.md): 23 kinds, each a deterministic measurement against a fixed threshold, the code
an app will load with `GenClass.init({ visual: { on: true } })` once a runtime release has it. **No released runtime
has it yet** (npm latest 0.2.1; main and release/0.3.0 have no `packages/runtime/src/visual`), so every sentence on
`/scan` and `/scan/about` that says where the checks and fixes come from is built from `VISUAL_IN_RUNTIME` in
`src/visual.ts` (null: "in testing, not in runtime 0.2.1"; set it to the version once that runtime is on npm, as the
site's `visual.json` `checks_in_runtime` does). Nothing in the scanner measures pages itself any more (the built-in
subset in `src/checks.ts` is gone).

- **Build.** CI job `scan-visual` (`.github/workflows/ci.yml`) checks out `wave2/visual` at `VISUAL_REF`, builds the
  runtime, and runs `scripts/build-visual.sh`, which bundles the runtime's lazy chunk `dist/visual/index.js` with
  `visual/scan-entry.js` (the scanner's side) into one IIFE in `src/visual-source.ts`, with `VISUAL_BUILD` (the commit,
  the chunk's sha256, the bundle's sha256). The job uploads it as the artifact `scan-visual` and fails when the
  committed file is not byte for byte that build. To move to a newer chunk: change `VISUAL_REF`, run
  `gh workflow run ci.yml --ref <branch>`, `gh run download <run> -n scan-visual`, copy `visual-source.ts` over
  `src/visual-source.ts`, commit. Never build the runtime on the owner's Mac.
- **How it runs** (`visual/scan-entry.js`). The chunk is started as the runtime starts it, `startVisual(rt, options)`,
  with a stand-in for the runtime object that its bridge reads (`src/visual/bridge.ts` RtLike): the mode the scanner
  asks for, sampled in, not paused, silent reports, and the page's fetch and XHR requests in flight. The scanner counts
  those in its request handler (requests it answers itself included; its own runtime and model downloads not) and
  hands the count in with the `net` command when it changes and at least once a second, polled every 250 ms, as the
  bench's harness counted fetch and XHR. The chunk does not judge `page-blank`, `pointer-events-leak` or
  `click-blocked` while a request runs (a busy shield is intended), so a page still loading its data after the 4 s
  quiet cap is not reported blank.
  Options: `on: true`, `lowEnd: "full"` (every kind on every device), `passBudgetMs: 1500` and `budgetMs: 16` so a long
  page gets a whole pass. One function, `window.__genclassScanVisual(command, argument)`, is taken by the installer
  (`src/visual.ts`) only when the bundle defined it, then lives under a per-scan random, non-writable name in the
  isolated world. Commands: `start`, `status`, `collect` (the first 40 findings as data, every finding's identity as
  `keys`, and the `total`), `stop`, `net`, `point`, `top`, `page`. A view with more than 40 findings says how many
  were left out of the report.
- **Per view** (`visualChecks` in `src/scan.ts`): engine "a" starts at network quiet; the scanner waits for its first
  pass (at most 4 s), presses Tab four times on the desktop (focus under a sticky bar), scrolls with the mouse wheel to
  the end of the page (controls under a fixed bar at the end), and once more about 3 s in, after the first periodic
  read (a scroll attempt while a scroll lock is held is the evidence that check needs), then collects at 6 s with one
  more pass at the top. Interaction checks that need a visitor's clicks (`click-blocked`) do not run: the scanner
  clicks nothing but the probe's submit button.
- **Files the scanner refused.** Findings about a file whose host the scanner itself did not load (a DNS lookup that
  failed, a private answer, a blocked address) are left out and counted in the view's notes. A name with no address at
  all is kept: it fails in a visitor's browser too.
- **CSP.** The checks start after load, when the browser no longer reports earlier Content-Security-Policy violations,
  so the safety bootstrap records them as plain data (`disposition`, directives, `blockedURI`, `sourceFile`) and the
  scanner hands them to the chunk as its early events. Only events the browser raised count (`isTrusted`): a page could
  otherwise dispatch its own and put text of its choosing in a public report. The desktop view runs with the page's CSP
  bypassed so the GenClass runtime can load for the race probe, so `csp-blocked` comes from the phone views only, and
  the desktop view says so.
- **Sideways scrolling on phones.** Chrome widens a phone's layout viewport to the content, so any full-width wrapper a
  wide child stretched trips the chunk's "a width of 100vw with a classic scrollbar" rule, and its `width: 100%` fix is
  for the wrong element (the fixture: `body > main`, where the cause is a 640 px box in a flex item that cannot shrink).
  On the phone views, when that cause shows or the layout viewport is wider than the phone, the scanner keeps the
  measured excess and drops the chunk's cause and CSS (`phoneOverflow` in `src/scan.ts`); the report gives the kind's
  own fix. The root cause belongs in the runtime's check (blame a scrollbar only when `innerWidth - clientWidth` is a
  scrollbar's width, and test the flex-item case first).
- **Results** are plain data (`serial` in the entry): kind, selector, box, the measured sentence, and in `detail` the
  check's severity, its suggested CSS (`css`, `cssNote`) or fix text (`fixText`), the threshold, and the fix state
  (`fixApplied`, `fixCss`, `fixReason`). `sanitizeFinding` in `src/catalog.ts` checks them again.

Measured for the runtime (RESULTS.md sections 8 and 9, GitHub runners, Chromium 153, 2026-10-13): 35 of 35 planted
faults on its fixture pages; on its bench, no false reports in 128 clean local page views, and recall 1.00 on planted
faults for 19 of 23 kinds (bench run 5); on public home pages (bench run 4: 31 of 40 sites measured, 96 loads), 8
findings, 5 confirmed real, 0 check errors, 3 unconfirmed. The scanner embeds the same checks at a later commit
(`6ae209f`; runs 4 and 5 were `5c47a71` and `47b94c1`) and runs them in Chrome 128 in Browser Rendering for about 6 s
per view with 4 Tab presses and no hover (the bench: hover over 8 controls, 8 Tab presses), so these numbers describe
the checks, not this scanner. `/scan/about` says the same.

## The deeper checks (scan-score/3)

Each one measures something a developer can reproduce, against a published threshold the finding names. Thresholds and
the reasons for each choice are in `src/audits.ts`, `src/axe.ts` and `src/cdp.ts`; `/scan/about#audits` publishes them.

- **axe-core 4.13.0** (`src/axe.ts`, `src/axe-source.ts`; MPL-2.0, embedded unmodified with its notice, built by
  `scripts/build-axe.mjs` from the pinned package; `test/axe.test.ts` fails when the committed file is not that package
  byte for byte). Installed in the isolated world of every view the way the visual chunk is (taken only when the
  embedded source defined it, pinned under a per-scan name, `window.axe` deleted). Tags `wcag2a`, `wcag2aa`, `wcag21a`,
  `wcag21aa`, `wcag22aa`, `best-practice`; violations only; no iframes; `preload: false` (no fetches); scroll restored;
  9 s at most per view. `target-size`, `meta-viewport` and `meta-viewport-large` are off: the phone audits measure the
  same thing. Needs-review results are a count (`metrics.axeIncomplete`), never findings. Impact is the severity;
  best-practice-only rules are one level lower. One finding per rule across views, its count the most elements any view
  found, up to 5 example selectors, the WCAG success criteria from its tags with their Understanding links, and axe's
  rule guide (`dequeuniversity.com` only). An element the visual checks reported as invisible text is removed from
  `color-contrast` in that view (counted once). `color-contrast` also leaves out text WCAG 1.4.3 exempts: inside an
  element marked `role="img"` or `aria-hidden="true"` (incidental), and text that is only the site's own name (a
  logotype); both measured in calibration.
- **Phone audits** (light phone, `pageSide("audit")`): WCAG 2.5.8 tap targets (links, buttons, form controls and control
  roles under 24×24 CSS px whose 24 px circle touches another target or another small target's circle; inline links in a
  sentence, checkboxes and radios at the browser's own size or with a 24×24 label, disabled, hidden, clipped and covered
  targets are left out; every target is hit-tested at its centre, half a screen at a time); WCAG 1.4.4 zoom
  (`user-scalable=no` or `maximum-scale` below 2); a missing viewport meta tag (Lighthouse's viewport audit), added from
  the phone layout when the visual checks did not report it; 12 px text (Lighthouse's legible font size: a body text
  block of at least 40 characters under 12 px is minor, more than 40% of the text is moderate); WCAG 1.4.10 reflow (the
  same page narrowed to 360 and 320 px without a reload: wider than the viewport and able to scroll sideways; serious at
  360, moderate at 320 only, minor when only tables or `pre` stick out; skipped when it already overflows at 390).
- **Images** (desktop and light phone): more than 4 times the pixels the image covers on a 2x (desktop) or 3x (phone)
  screen and more than 100 KB transferred (Lighthouse's "Properly size images", stricter); images without width/height
  or aspect-ratio (attributes or inline style), arriving after the first paint, tied to a layout shift that moved content
  below them within 500 ms of the image loading (always minor).
- **Reliability** (`src/cdp.ts`): uncaught errors and unhandled rejections in the page's own main-frame context,
  `console.error`, same-site scripts, data requests and frames answered 4xx or 5xx (images, stylesheets, fonts and media
  are the visual checks'; 401/403/407/429 counted in `metrics.whoAsks`, not scored; `/favicon.ico` left out), mixed
  content blocked (serious) or upgraded (minor). The scanner's own code and messages are filtered out. JavaScript errors
  are listed but not scored when every view they appeared in had stand-in answers or refused files.
- **Speed**: Largest Contentful Paint against web.dev on the faster of two loads, the desktop view and the light phone
  (minor above 2.5 s, moderate above 4 s; `lcpOnFasterLoad` in `src/report.ts`), every finding naming both and saying
  they were measured once in a data center. More than 1 MB of JavaScript is a note, not scored.
- **Layout shift is listed, not scored** (the scanner's CLS and the visual checks' `layout-shift`): every request in the
  scanner's browser waits for the scanner's checks, so content that scripts add after the first paint moves more than
  for most visitors. On the three public pages where the calibration measured a shift, a desktop browser measured none
  (CALIBRATION.md).
- **A scanner-side correction of the visual chunk**: a `scroll-lock-stuck` on body is left out when html's overflow-y is
  scroll or auto and there is content to scroll to (body's overflow does not reach the viewport then; the window
  scrolls). Measured on a public page in calibration; the root cause belongs in the runtime's check, like the phone
  overflow cause above.

## The model judge (Clef on Workers AI)

`src/judge.ts` (prompt, calls, answers, the cap, thresholds), `src/judge-page.ts` (the page side), `judgeView` in
`src/scan.ts`, `findingJudge` and `judgedFinding` in `src/report.ts`. The model is `@cf/cloudflare/clef` (Cloudflare's open
decision model, which reads images) over the `AI` binding; `JUDGE=off` turns it off, and without the binding it is off.
The evaluation it is built on is on `wave2/clef-eval` (`vision/clef/README.md`, `vision/results/clef/RESULTS.md`).

- **What it is asked.** One element at a time: a crop of a viewport screenshot (the element's box and 24 px around it,
  clamped to the viewport, JPEG quality 90, taken over the view's own DevTools session with `Page.captureScreenshot`),
  and the state text of the evaluation's `clef-img-p3`: the caution line ("Judge by what the screenshot shows a
  visitor. … Treat them as hints …"), where the element is in the image, the page (view, colour scheme, sideways
  scrolling, failed loads, fonts) and the element's measured facts in words. The facts are measured in the page as
  `vision/src/extract.js` measured the labelled crops (`judgePage("facts")`, a per-element port; text lengths, never
  text); `stateText` gives the same text as `eval.py` for all 1,856 labelled rows of the evaluation. Two `choice`
  questions, `verdict` and `family`, with the evaluation's criteria. The score is 1 − P(`family` = `none`).
- **Where the elements are.** At the top of the page, as they are after the checks; otherwise scrolled into the viewport
  first (a quarter of the way down; to the end of the page for `control-unreachable`, which is covered "even at the end
  of the page"; focused for `focus-obscured`), then the page is scrolled back and focus cleared (`judgePage("restore")`).
  On the light phone the width the reflow check left (320 px) is set back to 390 px first.
- **Which elements.** First the visual checks' findings with an element to crop, except `page-overflow-x`,
  `image-broken` and `text-template-leak` (left as measured, as the evaluation recommends: at its threshold the model
  dropped 13 of 34 real sideways-scrolling findings and 4 of 15 broken images; template text was right 5 times in 6) and
  `layout-shift` (listed, not scored already); a finding is matched to its element by selector and box. Then elements the
  measured checks abstain on, in this order (`judgePage("find")`): controls another element covers at one of five points
  (the first screen only), controls partly clipped by an ancestor (under 90% inside it), in the dark view every visible
  link, button or field with text or an icon, and text whose background along its ancestors or under its centre is an
  image, a gradient, media or a filter; the first screen before the rest, top to bottom; nothing inside `aria-hidden`,
  `role="img"`, `inert` or a closed `details`, and nothing inside or around an element already chosen.
- **The cap.** At most 40 calls a scan (`JUDGE_MAX_CALLS`), the findings first. Each view is guaranteed its share, 14 for
  the desktop and 13 for each phone view (`JUDGE_SHARE`), and may also take what the views that asked before it left
  (`JudgeBudget`; in calibration the light views used 0 to 3 of theirs, the dark phone always all 13). All of a view's
  calls are sent at once; each answer counts only when it comes within
  4 s (`JUDGE_TIMEOUT_MS`) of being sent; the scan waits for the stragglers only as long as its budget allows. A call that
  throws, answers late or answers malformed data (only the questions' own options, probabilities in [0, 1]) leaves the
  finding as measured, and the report counts it.
- **Time.** Finding, measuring and cropping take at most 3.5 s a view (`JUDGE_PREP_MS`), and only the time the deeper
  checks left before the race probe's 18 s reserve; under 0.8 s left the view skips the judge and says so. The calls run
  while the probe and the guard pass do.
- **Second stage.** A measured finding the model scores below 0.9777 (`KEEP_THRESHOLD`: recall 0.5 on the evaluation's
  dev split) in every view it appeared in is listed, not scored, under "Listed, not scored (a model judged it as probably
  fine)", with the crop; one view at or above it keeps it ("A model agreed"); a view without an answer leaves it as
  measured. On the evaluation's report split, the rules then the model at this threshold had precision 0.56 (rules alone
  0.225) and recall 0.535 (rules alone 0.807).
- **Findings of its own.** An element of the second kind scored at 0.9843 or more (`FIND_THRESHOLD`: the lowest dev
  threshold with precision at least 0.8, 5 of 6) becomes `visual-judged`: Visual bugs, moderate, its headline from the
  problem it named, "What the model saw" instead of "Measured", the label "Judged from the screenshot by a model (Clef)",
  the crop with the element outlined. Not where a measured finding of that view covers the same place (60% of the smaller
  box); one finding for the same element in the light and the dark phone. On the evaluation's report split, 33 of the
  44 crops scored that high were real (precision 0.75).
- **The labels.** The evaluation's 1,856 crops were labelled by six AI labeller agents working in parallel, not people (208
  labelled twice, Cohen's kappa 0.705); `/scan/about#judge` says so next to every number.
- **What is sent and kept.** The crop and the state text go to Workers AI, with no account or visitor data. Cloudflare's
  Workers AI data-usage page says it does not use what is sent to train models and stores it only when the account adds
  a storage service; the scanner adds none. The crops the report shows (every measured finding asked about, and the
  model's own findings) are saved next to the screenshots (`scans/shots/<key>/<id>-<view>-j<n>.jpg`, served by the shot
  route with the same opt-out check, deleted by the same 24-hour sweep). `JUDGE_CROPS=all` (the test copy only) keeps
  every crop and puts each call's state text in the report's `judge.asked`, for calibration.
- **Cost.** About 1,300 input tokens a call at $0.24 per million (Workers AI pricing, 2026-10-14): about $0.0003 a call,
  $0.0125 for 40. Each report has `judge` with the calls, answers, tokens and their price, and the times.

## The score and the with-GenClass column

`src/score.ts`, published on `/scan/about#score` from the same constants:

```
points(rule) = base(severity) × min(2, 1 + log10(instances))      base: critical 30, serious 15, moderate 7, minor 3
category     = 100 × Π over the category's rules (1 − points / 100)
score        = Σ weight × category / Σ weight, over the categories measured on this scan
weights      : Visual bugs 25, Accessibility 25, Phone 20, Reliability 15, Speed 10, Races 5
```

A rule is one visual kind, one axe-core rule or one audit; its severity is the most severe instance. A rule's points stop
at twice its base, so 200 instances of one rule take what 10 do. Rules multiply, so each further rule takes a share of
what is left and a category stays above 0. A category this scan did not measure (axe-core did not finish, no phone
audit, no DevTools record, no desktop timings, nothing for the race probe to try) is left out of the mean, shown as "not
measured" with the reason (`notMeasured`), and its findings are listed but not scored. The top issues are the five rules
that cost the overall score the most (`ruleImpact`: the score without the rule minus the score with it). The same
element with the same problem in several views counts once. A GenClass "duplicate" on a GET is minor. Findings marked
`unscored` are listed only. Deterministic: the same findings give the same score. Severities: the visual checks' high,
medium and low read as serious, moderate and minor (a blank page, a page that ignores clicks or cannot scroll:
critical); axe-core's impact; the audits' own. The weights were set before calibration and not changed by it.

With `WITH_GENCLASS=on` (the default now):

- **In testing.** The visual half of the column uses code no released runtime has; the column is labelled "With
  GenClass (in testing)" and every page and report says the fixes are in testing, not in runtime 0.2.1, until
  `VISUAL_IN_RUNTIME` is set. Set `WITH_GENCLASS=off` to run the visual checks report-only until the chunk ships.
- **Visual fixes, measured.** In every view engine "a" runs in guard mode with `fix: true`, which is what
  `GenClass.init({ mode: "guard", visual: { on: true, fix: true } })` will do: the chunk's own fix gate applies its three
  opt-in fixes (text colour for `text-invisible` through an adopted stylesheet rule; removing a leaked inline
  `pointer-events: none` or scroll lock on html or body) and re-measures each 50 ms later. When "a" applied a fix,
  engine "c", report-only, starts in the same page with the fixes in place and measures it again (with the same
  periodic reads when the fix was a periodic kind). A finding counts as fixed only when "a" applied its fix, the fix
  still holds, and "c" no longer finds it among every finding it reported (its `keys`, not only the first 40), in every
  view the finding appeared in (`recheck` in `src/scan.ts`, `visualFix` in `src/report.ts`). For the periodic kinds
  (`pointer-events-leak`, `scroll-lock-stuck`) "c" must also have run at least 4.5 s, since the chunk reports them only
  after two periodic reads 2 s apart; a shorter re-check says "did not run long enough" and does not count. Stopping
  "a" undoes every fix before the screenshot and before the race probe.
- **Only verified fixes are subtracted.** What "c" finds that "a" never reported (text that becomes measurable once a
  leaked `pointer-events: none` is removed, on the fixture's `?leak=1`) is not added to either score; the note says how
  many there were and of which kinds. The note names only the steps that ran (no re-check is mentioned when none ran).
- **Everything else is reported.** The other 20 kinds have no runtime fix by design (VISUAL.md 11.4); each such finding
  says "Reported for the developer" with the suggested CSS or code. A fixable kind that was not fixed says why (the
  chunk's own reason, for example a scroll lock held since load, or "the re-check still found the problem").
- **Races.** A double submit counts as fixed only when guard's own coalesce, defer or discard on the clicked request
  sent fewer requests (`guardClickFix`). A late response GenClass diagnosed counts only for guard's own recorded
  discard or defer on that same request (subjects compared without their `(#N)` number, never an empty one), with no
  other unacted diagnosis on it left in the guard pass, worded as the recorded action. When guard diagnosed it but its
  expected gain did not clear the margin, the finding says "Flagged, held back at the default safety margin" with the
  confidence, the gain, the margin and what the guard pass's double click measurably sent ("the page sent 2 identical
  requests (the scanner answered them; none reached the site)") (`heldBack`; the page uses the same match on the
  clicked request).

**Owner decision still open** for the race half: at the shipped gates guard holds back on the fixture's double submit
(expected gain 2.5 to 3.0 against a margin of 4), so the with-GenClass score counts the visual fixes only there. The home
page lab's demo gates (`GUARD_MARGIN=0`, `GUARD_AGGRESSIVENESS=eager`) make guard coalesce it; the report would name
that as a demo setting.

## Configuration (`wrangler.jsonc` vars)

| var | default | what |
|---|---|---|
| `MAX_CONCURRENT` | `10` | scans at once across everyone; each holds one Browser Rendering browser. Browser Rendering on Workers Paid allows 200 at once and 3 new browsers a second (developers.cloudflare.com/browser-rendering/limits, updated 2026-09-26; Free: 3 and one per 20 s). The bound here is the lease file `scans/slots.json`, written twice per scan, and R2 takes one write a second per key (more get 429, which the lease code retries): 10 scans of about 35 s are about 0.6 writes a second. A lease is not taken while 3 others started in the last second (`LAUNCHES_PER_SECOND`), `now` is read on every attempt, and an acquire that lost every compare-and-swap round (or got 429) answers 503 `contention` with `retry-after: 3`, which the page retries by itself up to 4 times, instead of "all busy". A release gets 10 rounds. Under a launch-day burst this is still one key: move the leases to a Durable Object before going much higher |
| `WITH_GENCLASS` | `on` | the with-GenClass column: visual fixes in guard mode, re-checked, and the race probe's guard pass; `off` runs the visual checks report-only |
| `GUARD_HOLD_MS` | `900` | `policy.holdBudgetMs` in the guard pass (the WASM model's decisions take 180 to 450 ms here) |
| `GUARD_AGGRESSIVENESS` | unset = `balanced` | the guard pass's profile; the report names it |
| `GUARD_MARGIN` | unset | `policy.thresholds.guard` (a gain margin) for the guard pass; the report and `/scan/about` call it a demo setting |
| `BLOCKLIST` | unset | extra opted-out hosts, comma-separated |
| `PUBLIC_ORIGIN` | genclass.dev on genclass.dev, else this origin | base of share links |
| `STORE_PREFIX` | unset (production) | a test copy's key prefix in the bucket (`scan-test/` in env `test`, `src/prefix.ts`): its reports, screenshots and leases live under it; the opt-out list `scans/blocklist.json` is shared |
| `JUDGE` | `on` | the model judge over the `AI` binding; `off` runs the measured checks only |
| `JUDGE_CROPS` | unset (production), `all` in env `test` | keep every judged crop and put each call's state text in the report (calibration) |

Bindings: `BROWSER` (Browser Rendering), `AI` (Workers AI, the model judge), `BUCKET` (R2 `genclass-telemetry`, `scans/` prefix only), `SCAN_LIMIT`
(per client, namespace 4810), `SITE_LIMIT` (per site, namespace 4811) and `SITE` (the site worker `genclass-site`, for
`/scan…` paths that are the site's). The env `test` repeats every binding (they are not inherited), sets `"routes": []`
(routes are inherited unless set; wrangler resolves `rawEnv.routes ?? topLevel.routes`, so an empty list means none),
its own rate-limit namespaces 4820 and 4821, `MAX_CONCURRENT` 3 and `STORE_PREFIX` `scan-test/`, and keeps the hourly
sweep over its prefix. Compatibility flag `enable_request_signal`
(a cancelled request stops its scan). Hourly cron `23 * * * *` deletes `scans/shots/` and `scans/reports/` objects older than
24 hours (`sweep` in `src/store.ts`); no R2 lifecycle rule was added.

## Tests

```bash
cd scan-worker && npm ci && npm run typecheck && npm test     # node:test with type stripping (Node >= 22.18)
node --test site/check/scan-path.test.mjs                     # the site worker's genclass.dev/<url> rule (from the repo root)
```

`test/target.test.ts` (normalisation, IPv4/IPv6 forms, IDN, trailing dots, userinfo, DNS, robots, the per-site key),
`test/policy.test.ts` (non-GET answered locally, blocked hosts and redirect hops aborted, a DNS check for every name,
the navigation check, no navigation to genclass.dev or after load, no third-party submits, latency),
`test/report.test.ts` (score caps, determinism, merging, every visual kind in the catalog, measured severities, visual
fixes only when fixed and re-checked in every view, "reported" for kinds GenClass does not fix, race fixes tied to the
clicked request, "held back at the default safety margin", stand-in findings unscored, page data validated),
`test/checks.test.ts` (the embedded chunk is the build of the pinned commit and names all 23 kinds, it installs from the
bundle and only from it, the runtime state out of the page's reach, new-window forms skipped, the safety bootstrap and
its CSP record), `test/app.test.ts` (the HTTP surface with the browser mocked: refusals in order, rate limits per client
and site, one scan per client, IPv6 /64, automated clients, cache and its version, slots, a full streamed scan with the
interception outcome of every request and the visual commands per view, the with-GenClass flow with a re-check, files
the scanner refused, private names and addresses, redirects to opted-out or robots-disallowed sites, WebSocket hosts,
stand-in answers, cancellation, screenshots and opt-outs, report escaping, the path form, the sweep),
`test/tlds.test.ts` (the two TLD copies and path rules agree), and the launch review's fixes in `test/app.test.ts`
and `test/report.test.ts` (the in-flight count reaches the checks before they start, periodic fixes need a long enough
re-check, the re-check is compared with every key, uncovered findings are named and not scored, the phone overflow
cause, the report without JavaScript, the "in testing" wording, `/scan…` paths handed to the site, contention and
launch pacing, race fixes tied to the same request, the held-back words). For scan-score/3: `test/score.test.ts`
(rule points and their cap, diminishing deductions, the weighted mean, unmeasured categories left out, rule impact),
`test/axe.test.ts` (the embedded axe-core is the pinned package byte for byte with its MPL-2.0 notice, the installer,
the run's options, impact to severity, best practices one level lower, rules off and misshapen data dropped, the
invisible-text duplicate, hostile rule text escaped and links only to the standards' own sites), `test/audits.test.ts`
(each audit's threshold with fixtures: tap targets and the spacing exception, zoom, text size, reflow, oversized and
unsized images, LCP and CLS session windows, overflow propagation), `test/cdp.test.ts` (errors from the main frame only,
the scanner's own left out, failed same-site requests by type and status, who-asks statuses, mixed content, JavaScript
bytes, the test copy's bucket prefix), and in `test/app.test.ts` a full deep scan through the mocked browser (axe-core
in every view, the phone narrowed to 360 and 320, the DevTools record, the static report's six categories and top
issues), categories left unmeasured when time runs out or there is no DevTools session, and the scroll-lock
correction. `test/judge.test.ts` (the model judge: the state text word for word with Python's rounding, the Clef input,
answers read back and refused when malformed, unknown options ignored, a call that throws, hangs or answers nonsense
never breaking anything, the 40-call cap and its shares, the scroll groups, the page's list checked, the page side
serialised without bundler names; through the mocked browser and a fake `AI`: 40 calls at most across the views, a
finding kept, one listed as probably fine and not scored, every finding as measured when the model is down or hangs,
off without the binding or with `JUDGE=off`, the three kinds and box-less findings never sent; the two thresholds at their
edges, every view needed for "probably fine", no finding of its own over a measured one, the light and dark phone merged,
which crops are kept; `/scan/about` and the report page wording, and escaping of what the model and the page said, with
only this origin's crop URLs shown). CI jobs: `scan-worker` and `scan-visual` in `.github/workflows/ci.yml`.

`test/fixture/` is a test page with problems on purpose (`genclass-scan-fixture.mehar-144.workers.dev`): text at
1.08:1, `Total: $NaN`, a 404 stylesheet, a 404 image, a 640 px box on a 390 px phone, a link at the end of the page
under a fixed bar, a typeahead and a subscribe form for the race probe. `?leak=1` leaves `pointer-events: none` on body,
as a menu that closed without releasing it does.
`?blank=1` adds a bigger POST form with `target=_blank` (the probe must skip it), `?standin=1` a price loaded by POST
while the page loads (the report must say so and not score what follows from it). `?deep=1` adds one deliberate problem
per deeper check (zoom off, text at 2.85:1, an image without alt, a button with no name, 16 px tap targets side by side,
10 px body text, a 340 px box that fits 390 px but not 360 or 320, an 800×600 image of 1.4 MB shown at 80×60, an image
without dimensions that arrives after 1.5 s and pushes the page down, an uncaught TypeError, a console.error, a 404
script, a script and an image asked for over http); `?deep=1&slow=1` delays the late image to 4.5 s. The default page is
unchanged. Non-GET requests that reach the fixture are logged (`wrangler tail genclass-scan-fixture`). Calibration on
public pages: `CALIBRATION.md`.

## Re-run after the launch review's fixes (2026-10-14, test copy, report version 5)

The test copy redeployed from this branch (`WITH_GENCLASS=on`, shipped guard gates), the fixture only. Times in ms:
launch / three views in parallel / observe probe / guard pass.

| page | total | launch / views / probe / guard | score | with GenClass (in testing) | findings | what it showed |
|---|---|---|---|---|---|---|
| Fixture | 27.9 s | 1,135 / 13,815 / 5,408 / 7,446 | 25 | 35 | 8 | the 1.08:1 text fixed in all three views (re-check: gone); the double submit flagged at 99% in observe and held back in guard (expected gain 2.86, margin 4): "the page sent 2 identical requests (the scanner answered them; none reached the site)"; sideways scrolling on the phones now reads "ends at 696 px (306 px too wide)" with the kind's own fix, no 100vw cause; the desktop view notes its CSP was bypassed |
| Fixture `?standin=1` | 30.8 s | 1,006 / 15,491 / 5,595 / 8,601 | 45 | 55 | 8 (2 not scored) | each view noted the POST answered while loading; the faint text was found and fixed on the light phone only, and both phone views noted that their passes ran out of time budget |
| Fixture `?leak=1`, three runs | 14.4 / 22.1 / 23.5 s | 492 / 10,720 / 105 / 3,030 in the first | 45, 35, 35 | 45, 45, 45 | 6, 7, 7 | runs 2 and 3: the leaked `pointer-events: none` on body found and removed in all three views (re-check: gone); run 1: it was not reported in any view, so nothing was fixed (the fixture makes no fetch or XHR requests, so the new in-flight count was 0 throughout; the cause is not known) |

The page at 1440 and 375 px wide, with and without JavaScript: the score, the table and the findings render from the
cached report without JavaScript, an uncached address shows the `<noscript>` notice, nothing scrolls sideways at 375 px
(the "With GenClass (in testing)" header wraps), and number tags sit above their boxes on the phone figures.

## End-to-end runs with the GenClass visual chunk (2026-10-14, test copy, Chrome 128 in Browser Rendering)

These runs predate commit `a71d3d6` (score text `scan-score/2`) and the launch review's fixes (report version 5); the
re-run after them is in the next section. The deployed test copy (`WITH_GENCLASS=on`, the shipped guard gates, `MAX_CONCURRENT=10`), the fixture and the same
three public pages as below (not named). Times in ms: launch / three views in parallel / observe probe / guard pass.

| page | total | launch / views / probe / guard | score | with GenClass | findings | what GenClass did |
|---|---|---|---|---|---|---|
| Fixture | 32.5 s | 1,143 / 15,910 / 5,821 / 9,453 | 25 | 35 | 8 | fixed the 1.08:1 text in all three views (the re-check no longer found it); flagged the double submit at 99% in observe, held back in guard at the default margin (expected gain 2.80, margin 4), 2 requests sent; reported the other 6 for the developer |
| Fixture `?leak=1` | 22.1 s | 798 / 18,331 / 170 / 2,687 | 35 | 45 | 7 | removed the leaked inline `pointer-events: none` on body in all three views (re-check: gone); reported the other 6 |
| Site A: a plain static page | 15.1 s | 973 / 10,022 / 294 / 3,597 | 90 | 90 | 1 | reported: no viewport meta tag, so phones lay it out 980 px wide |
| Site B: a JavaScript-heavy app | 20.3 s | 837 / 10,068 / 3,084 / 6,127 | 100 | 100 | 0 | nothing to fix; nothing to probe but its search box (0 requests while typing) |
| Site C: a site made with an AI app builder | 23.0 s | 818 / 11,463 / 3,155 / 7,399 | 100 | 100 | 0 | nothing to fix; its form's own code stopped the empty double submit |

What these runs show, plainly:

- The fixture's findings: text at 1.08:1, `Total: $NaN`, the 404 stylesheet, the 404 image, sideways scrolling on the
  phones, the Terms link under the fixed bar (control-unreachable, and focus-obscured when Tab reached it), and the double
  submit. The overflow's measured sentence names `body > main` and "a width of 100vw with a classic scrollbar"; the
  cause on this page is the 640 px box inside it. That sentence is the chunk's own (Chrome lays the phone page out
  696 px wide and zooms out, as a phone does), noted here for the runtime's checks.
- `?leak=1`: with `pointer-events: none` on body, hit testing skips the whole page, so the contrast check cannot measure
  the faint text there (it abstains rather than guessing) and the probe finds nothing to click.
- Each view takes about 9 to 16 s (load, 6 s of checks, the re-check when a fix was applied, the screenshot); a
  periodic fix (pointer-events) adds about 6 s for its re-check. All runs finished between 15 and 33 s of the 45 s budget.
- Passes that ran out of their budget: Site B, 1 or 2 of 3 or 4 passes per view (long pages); the rest finished.
- Before each view had its own browser window (first run, same day): the desktop and phone tabs reported themselves
  hidden, their checks made no pass, and the observe probe did not flag the double submit. With a window per view every
  view is visible, every view made 2 to 4 passes, and the observe probe flagged it at 99% again.

## End-to-end runs (2026-10-13, test copy, Chrome 128 in Browser Rendering)

Three public pages, chosen to cover the range, and the fixture. Sites are not named; the findings describe one load of
one page with these checks, nothing more. Times are the scanner's own measurements in ms (launch / three views in
parallel / observe probe / guard pass).

| page | total | launch / views / probe / guard | score | findings | GenClass model (WASM, q8) | race probe |
|---|---|---|---|---|---|---|
| Site A: a plain static page | 12.9 s | 1,153 / 4,047 / 2,666 / 4,754 | 100 | 0 | ready, loaded in 3.4 s | nothing to probe: no search box, no form that posts |
| Site B: a JavaScript-heavy app | 15.0 s | 1,268 / 4,758 / 2,973 / 5,831 | 100 | 0 | ready, 2.7 s | typed into its search box: 0 requests while typing; no form that posts |
| Site C: a site made with an AI app builder, from the builder community's public showcase | 14.5 s | 740 / 4,310 / 3,460 / 5,796 | 100 | 0 | ready, 1.8 s | double-clicked its form's submit button: 0 requests (the page's own code stopped the empty submit) |
| Fixture: deliberate problems | 22.7 s | 766 / 5,511 / 7,446 / 8,783 | 40 | 7 | ready, 2.0 s | 3 typeahead requests, answered out of order (3, 1, 2); 2 identical POSTs from one double click |

What these runs show, plainly:

- The fixture's seven deliberate problems were each found once (merged across the three views): text at 1.08:1,
  `Total: NaN`, a 404 stylesheet, a 404 image, a 640 px box that makes the page 680 px wide on a 390 px phone, a link
  under a transparent layer, and the double submit.
- On the fixture, GenClass in observe mode flagged the second POST as a duplicate at 99% confidence. In guard mode at
  the shipped `balanced` gates it **did not act**: coalesce scored a gain of 2.85 to 3.02 against a margin of 4 (3 with
  `eager`), so 2 requests were still sent. With the home-page lab's demo setting (`GUARD_MARGIN=0`,
  `GUARD_AGGRESSIVENESS=eager`, one run with `WITH_GENCLASS=on`) guard coalesced it: 1 request sent instead of 2, the
  with-GenClass score was 50 against 40. The deployed test copy uses the shipped gates.
- The three public pages had no findings from these checks. The contrast check is conservative and skips text it cannot
  measure: on Site C it measured 1 of 17 text elements in the captured area (9 over images or gradients, 6 under
  backdrop filters, 1 clipped background), on Site B 12 of 24. Site A has no viewport meta tag; the report notes that
  phones show it zoomed out at 980 px.
- 21 scans in all while building this (Sites A to C, the fixture eight times, eight other public pages): every one
  finished between 7.3 and 23.7 s, none near the 45 s budget. Of the 11 public pages, one had a finding (a web font that
  failed to load, score 98); the others scored 100. One JavaScript-heavy page answered HTTP 403 to the automated browser
  (bot protection) and was replaced for Site B; the report shows such a page as it was served.

### Re-check after the review fixes (2026-10-13, test copy)

| run | total | score | what it showed |
|---|---|---|---|
| fixture | 23.3 to 25.7 s | 40 | the same 7 findings; GenClass observe flagged the double submit at 99%, guard at the default settings held back (expected gain 2.81 to 3.03, margin 4), 2 requests sent both times |
| fixture `?blank=1` | 16.1 s | 40 | the `target=_blank` form was skipped; the probe double-clicked Subscribe |
| fixture `?standin=1` | 23.0 s | 55 | each view noted 1 POST answered by the scanner while loading; `Price: NaN` from it, and the page's other leak and broken image, listed but not scored |
| a plain static page | 8.9 s | 100 | no findings; the model was ready and made no decisions |
| a large documentation site | 8.5 s | 100 | each view noted 1 POST answered while loading |

No request other than GET reached the fixture in any of these runs (`wrangler tail`). A run cut off by the client
after 6 s stopped, saved nothing, and the same client could start a new scan 5 s later. The first run after the
remote-address check went in was thrown away because every response reported `::1` (the proxy, above), which is why
the DNS pre-check of every name is the enforcement and the address check applies only without a proxy.

## Deploying

```bash
cd scan-worker && npm ci
npx --yes wrangler@4 deploy --env test                           # the test copy: genclass-scan-test, workers.dev only, no routes
npx --yes wrangler@4 deploy -c test/fixture/wrangler.jsonc       # the fixture page (optional)
npx --yes wrangler@4 deploy                                      # production (genclass-scan, with the genclass.dev routes): the owner only
```

The production worker has had its genclass.dev routes since 2026-10-14 (`wrangler.jsonc`), so a plain `wrangler deploy`
from this directory deploys to them. scan-score/3 has been deployed to the test env only. Before production: review
`CALIBRATION.md` and the wording on the test copy's `/scan` and `/scan/about`; `REPORT_VERSION` 6 makes every cached
version-5 report a miss, so pages rescan on their first view. After a production deploy, check that
`genclass.dev/scan-box.js` (or the name the site gives it)
answers 200 with `text/javascript`, and that `genclass.dev/scan?url=…` and `genclass.dev/api/scan/health` reach this
worker.
