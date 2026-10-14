# vision: training data for visual checks

Status: pipeline v2, run 2026-10-14 (`results/v2/README.md`): 6,011 AI-builder and 1,209 control homepages, one load
each; the provenance audit passes at ROC AUC 0.528 (first build 0.657, see [Provenance audit](#provenance-audit));
2,200 crops from held-out hosts on 184 contact sheets, labelled by 6 labellers (139 real). The v2 models are trained
and judged on those real pages (`results/v2/TRAINING.md`). Two families met the ship criterion (at least 60% of flags
real on held-out pages, threshold chosen on dev): media, as a filter on the measured media checks (19 of 27 flags
real, against 19 of 44 for the checks alone), and responsive (7 of 10). The other families stay on the measured
checks. The shipping bundle is `results/v2/train/visual-v2.json` (57 KB gzip, 12.8 us per element in
`train/detect_v2.mjs`). Nothing in this folder is in a package: `vision/` is not a root workspace, has its own `package.json`
and lockfile (generated on a cluster node), and is not in any package's `files`. It feeds the visual checks designed
in `docs/runtime/VISUAL.md` (branch `wave2/visual`) and uses the bug catalog and fault recipes in `research/visual/`
(`CATALOG.md`, `injectors.json`). The network model and its text (`situation-v2.3`) are not touched.

v1 (the first full run, 2026-10-14: 3,000 AI-builder and 600 control homepages, 35,074 injected faults in 13 families,
summarised in `results/README.md`, trained and evaluated in `results/TRAINING.md`) showed that a model trained on
injected faults learns the injection: on injected faults it beat the measured thresholds (recall 0.56 against 0.07 at
about 0.5% false reports), on real pages 1 of its 99 flags was a real bug. TRAINING.md section 9 lists the causes.
v2 changes the pipeline so the injection leaves nothing a model can read, checks that it does not, and collects
crops of real pages for a labelled real-bug test set (the v2 run's numbers are in `results/v2/README.md`):

1. Traceless injection (`src/inject.mjs`): no inline style attribute, data-* or class marker on any element; every
   fault goes through one constructed stylesheet with structural selectors; labels live in a JS-side WeakMap; 30 of
   148 runnable recipes are dropped from training, each with its reason ([Fault injection](#fault-injection)).
2. Provenance audit (`train/provenance.py`): the columns that recorded how a view was made are gone, and a classifier
   must fail to tell clean elements of injected views from natural elements of the same page (ROC AUC under 0.55)
   before any model is trained ([Provenance audit](#provenance-audit)).
3. Ethics: one page load per host (desktop, then the same page resized to the phone viewport and switched to dark in
   place), a user agent with a contact URL, robots.txt for the final host after redirects, no recipe that makes the
   page request anything ([The crawl](#the-crawl)).
4. Candidates for labelling: up to 6 crops per natural view, chosen by the v1 model, the v1 rules and at random
   (`src/candidates.mjs`), tiled into contact sheets on the node (`label/sheets.py`)
   ([Candidates for labelling](#candidates-for-labelling)).

Everything that loads a browser or queries Common Crawl runs on a cluster node, never on the Mac. The only things
meant for the Mac are the browser-free tests ([Test](#test)).

## Pieces

| file | runs | what |
|---|---|---|
| `src/discover.mjs` | node | URL lists from the Common Crawl URL index: one homepage per host on AI-builder hosting domains, sampled general hosts, and a Tranco control sample |
| `src/crawl.mjs` | node | Playwright Chromium (headless shell), many contexts in parallel: robots.txt (also for the final host), one load per host, natural views (desktop, phone size, light, dark), labelling crops, extraction, screenshots, injection rounds in place |
| `src/extract.js` | in the page | the per-element feature extractor (classic script, no imports); labels come from the injection runtime's WeakMap and never change a row |
| `src/inject.mjs` | node and page | the traceless injection runtime: applies `research/visual/injectors.json` recipes, moves what they write into one constructed stylesheet, labels in a WeakMap, undo journal; `DROPPED` lists the recipes left out and why |
| `src/candidates.mjs` | node | labelling candidates of natural views: the frozen v1 encoder and gbt-small scorer, the v1 rules on raw rows, the choice of at most 6 per view, crop rectangles and ids |
| `src/robots.mjs` | node | robots.txt rules (RFC 9309 matching) |
| `src/build_set.mjs` | node | the training set from merged crawl shards: near-duplicate removal, host splits, feature matrices, labels, pixel verdicts, `summary.json` |
| `train/provenance.py` | node | the provenance audit; writes `provenance.json`, which `train_gbt.py` and `train_mlp.py` require |
| `train/baseline.py` | node | a sanity baseline on the training set (scikit-learn, the jev venv on the node) |
| `train/common.py` | node | loading, model inputs, the VISUAL.md measured thresholds as per-row rules, the provenance gate |
| `train/train_gbt.py`, `train/train_mlp.py` | node | LightGBM trees and a small MLP, fault against everything else |
| `train/evaluate.py` | node | operating points chosen on dev, recall per family and per page at each false-report rate on test |
| `train/export.py`, `train/gbt.mjs` | node | compact JSON tree export and ONNX, with a dependency-free JS evaluator and its parity and cost check |
| `train/crops.py` | node | v1: screenshot crops of flags on natural test pages for a hand check |
| `label/sheets.py` | node | contact sheets of the labelling crops: 12 per PNG (3 x 4, about 1,400 px wide, each cell numbered with its crop id), `index.json`, `labels.csv` |
| `results/train/gbt-small.json` | | the exported v1 small model (not shipped); v2 uses it only to choose labelling candidates |
| `results/` | | summaries copied from the node (no raw data, no crops); `results/v2/` holds the v2 run |
| `scripts/node_setup.sh` | node | Node 22.22.0 (checksum verified), `npm ci`, Playwright Chromium and its system libraries, `~/vision-out` |
| `scripts/cluster.sh` | Mac | `sync`, `setup`, `exec`, `crawl`, `status` over ssh, hosts from `~/.jev-local/azure_hosts` |
| `test/*.test.mjs` | anywhere | browser-free: extractor helpers, discovery, robots rules, recipe selection, the dropped list and the recipe lint, the runtime's structural selectors, the v1 encoder and rules, candidate choice; fixtures in `test/fixtures/` |
| `test/browser/traceless.mjs` | node | every trainable recipe on `test/browser/fixture.html` in Chromium: no trace left, the undo restores the page, no request made |
| `label/resolve.py` | node | joins the labellers' verdicts to crop sidecars and training-set rows; two votes that disagree become unclear; agreement rate and Cohen's kappa; a node copy with hosts and notes, a public copy with crop ids only |
| `label/sheets_extra.py` | node | contact sheets of extra crops from TRAIN hosts, stratified by the v1 rule that flagged them (training-only labels) |
| `train/train_v2.py` | node | v2: one LightGBM model per family (and a pooled one) on pixel-seen faults and labelled real bugs against matched clean elements and labelled not-bugs; random search; 5-fold host cross-fitting of the labelled val crops; a labelled-crop model and per-family stacks |
| `train/eval_v2.py` | node | v2: real pages first (labelled test crops: precision of flags, recall of labelled real bugs), injected faults at 0.1% and 1% false reports, the rules, the hybrid (a rule's flags kept when the v2 score passes a dev threshold) and the ship criterion |
| `train/handcheck_v2.py` | node | blind sheets of model and rule flags on natural test pages outside the labelled set, and their scoring |
| `train/export_v2.py`, `train/detect_v2.mjs` | node | v2: the shipping detectors as one JSON bundle (`genclass-visual-2`: tree models in the compact format, check filters and stacks) and its dependency-free JS evaluator with the parity and cost check |
| `label/test_sheets.py`, `label/test_resolve.py`, `train/test_provenance.py` | anywhere | Python unit tests of the sheets and of the audit's matching and rank AUC (no model trained) |

## Running on a node

From the Mac (bash, not zsh: zsh eats the colon in `user@$IP:dir/`):

```bash
# 1. claim the nodes first (protocol below), then
bash vision/scripts/cluster.sh sync  "c20 c21 c22 c23"   # vision/ and research/visual/ to ~/gcl/
bash vision/scripts/cluster.sh setup "c20 c21 c22 c23"   # detached; log in ~/vision-setup.log ("setup ok on ...")
# 2. the in-browser injection check on one node (about a minute): must end with "failed": 0
bash vision/scripts/cluster.sh exec c20 'node test/browser/traceless.mjs --out ~/vision-out/traceless.json | tail -3'
# 3. discovery on one node (about 35 s with the ZipNum files), then copy urls.jsonl to the others
bash vision/scripts/cluster.sh exec c20 'node src/discover.mjs --crawls 6 --ai-hosts 30000'
# 4. the crawl: shard i of N on the i-th host, detached; resumes from done-*.jsonl when restarted
bash vision/scripts/cluster.sh crawl "c20 c21 c22 c23" --workers 56 --inject 1 --groups ai-builder,control \
  --targets ai-builder=3000,control=600
bash vision/scripts/cluster.sh status "c20 c21 c22 c23"
# 5. copy every shard to the node that will train (inside the VNet), then on that node:
#    node --max-old-space-size=64000 src/build_set.mjs --in ~/vision-out/crawl --out ~/vision-out/trainset
#    LD_LIBRARY_PATH=~/vt-venv/gomp ~/vt-venv/bin/python train/provenance.py   # must pass before any training
#    ~/vt-venv/bin/python label/sheets.py --crops ~/vision-out/crawl --out ~/vision-out/label \
#      --quota rules=800,gbt=700,random=700 --per-view 2 --views ~/vision-out/trainset/views.jsonl.gz --splits val,test
```

v2 labels, training, evaluation, hand check and export (after the steps above): `results/v2/TRAINING.md` section 10.

On a node directly: `cd ~/gcl/vision && node src/crawl.mjs --urls ~/vision-out/discover/urls.jsonl --shard 0/4`.
Flags: `--workers` (default 60% of vCPUs), `--per-browser 8` (contexts per Chromium process), `--limit`,
`--inject` (share of hosts that get injection rounds, default 0.35), `--rounds desktop=8,phone=6` (rounds per device
size), `--targets ai-builder=3000,control=600` (hosts with views per group across all shards; each shard takes its
share and stops taking that group when full), `--dark-share 0.333` (hosts that also get dark views, desktop and
phone), `--pixel false` (skip the pixel check), `--crops false` (no labelling crops), `--crops-per-view 6`,
`--v1-model`, `--v1-schema` (default `results/train/gbt-small.json` and `results/schema.json`), `--seed`,
`--timeout 15000` (the load), `--max-rows 2500` (per view), `--groups ai-builder,mixed-host,control`,
`--shots false`.

Cluster rules that apply (`internal/training/NEEDS.md` has the claim table): check other agents' processes and take
the `~/.gcl-claim` lock on each node before using it; run `az` one call at a time with `--query` and `timeout 120`;
release the lock and deallocate every node you started when the stage ends. The 03:00 UTC auto-shutdown is the
backstop, not the plan.

Pseudonyms: crawled sites are never named as buggy in the repo, in commit messages or in results. Results use
`site-NNN`; crop ids carry no host; any mapping from pseudonym to host stays on the node. Screenshots and crops stay
on the node (or in a private scratch folder), never in git.

## Discovery

Two ways to read the same CDX records. The default (`--via files`) reads each crawl's ZipNum index from
`data.commoncrawl.org`: `cluster.idx` (105 MB for CC-MAIN-2026-39) maps SURT key ranges to gzip blocks of about
3,000 lines in `cdx-NNNNN.gz`, so a domain's blocks are found by binary search and read with HTTP range requests.
That is what the CDX API server does internally. `--via api` uses `index.commoncrawl.org` (showNumPages, then
page=N); on 2026-10-13 it took 287 s for three requests and returned 502 to one of two timed probes, so it is the
fallback.

A host appears once (a leading `www.` ignored); within a domain the newest crawl's capture wins, and only hosts with
a 200 `text/html` capture count. Platform hosts (the bare domain, `www`, `docs`, `api` and similar) are dropped.
Mixed hosts are capped at 1,500 per domain (seeded sample); AI-builder hosts are kept in full.

Run on c20 on 2026-10-13 over the six newest crawls (CC-MAIN-2026-39, -34, -30, -25, -21, -17), 32 s:

| group | domain | hosts |
|---|---|---|
| ai-builder | lovable.app | 14,365 |
| ai-builder | base44.app | 2,959 |
| ai-builder | replit.app | 2,186 |
| ai-builder | manus.space | 1,914 |
| ai-builder | vusercontent.net (v0) | 102 |
| ai-builder | created.app | 96 |
| ai-builder | emergent.host | 90 |
| ai-builder | mocha.app | 60 |
| ai-builder | genspark.space | 23 |
| ai-builder | windsurf.build | 12 |
| ai-builder | bolt.host, lovableproject.com, repl.co, v0.app | 0 |
| mixed-host | vercel.app, netlify.app, onrender.com, web.app (1,500 each of 45,451, 28,282, 2,658, 10,016) | 6,000 |
| mixed-host | hosted.app | 242 |
| mixed-host | pages.dev (only robots.txt captures) | 0 |
| control | Tranco list 64VKX, top 100,000, equal thirds from ranks 1 to 1k, 1k to 10k, 10k to 100k | 3,668 |
| | total | 31,717 |

bolt.host had 16 to 28 captures in each of the three newest crawls and none was a 200 HTML page. Bolt apps deployed to Netlify are among the
netlify.app sample; the crawl's builder fingerprints (`page.fp`) separate them where the page says so.

Output: `~/vision-out/discover/urls.jsonl` (`{url, host, group, builder, domain, source, crawl, ts, rank, shard}`,
`shard` is the first byte of SHA-1 of the host), `summary.json`, and `cache/` (cluster.idx files and blocks). The
list is not committed: it is 7.7 MB and the run above reproduces it with `--seed 7`.

## The crawl

Per host, one page load:

1. robots.txt for the token `genclass-vision` (else `*`), fetched with the user agent below; a disallowed path, a 5xx
   or no answer skips the host.
2. One `goto` of the homepage in a desktop context (1366x768, DPR 1, no touch) with a 15 s cap (if `load` does not
   fire, whatever committed is measured). The user agent is a desktop Chrome string followed by
   `genclass-vision/0.2 (+https://genclass.dev/security)`; robots.txt is fetched with that product token alone. The
   URL is the site's security page, which gives a contact address; there was no crawler about page when v2 ran.
3. After the redirects, robots.txt of the final host is checked for the final path (cached per process); a disallow,
   5xx or no answer discards the load before anything is extracted (`done` status `robots-final:...`). A client-side
   navigation later in the load (a redirect script, pushState) is checked the same way before the next extraction.
4. Fonts ready (3 s cap) and 500 ms without DOM mutations (5 s cap), then the natural views, each extracted and
   screenshotted (viewport only, JPEG quality 55, 683x384 desktop and 293x633 phone): desktop light; desktop dark on
   a seeded third of hosts (`emulateMedia` dark in place, a 1.5 s settle); then `page.setViewportSize(390x844)` on
   the same page for phone light and, on the same hosts, phone dark. Up to 6 labelling crops per natural view
   ([Candidates for labelling](#candidates-for-labelling)).
5. On a seeded share of hosts (`--inject`), injection rounds in place ([Fault injection](#fault-injection)): phone
   rounds at the phone size, then the desktop size again for desktop rounds. Natural views always come first, so no
   natural view follows an injection.

Nothing else is requested from the host by the crawler: no links followed, no reloads, no second load. The phone
views are the desktop page at the phone viewport: the viewport meta, `hover: none` and `pointer: coarse` do not apply
(no mobile emulation without a new load), so catalog entries 3 and 11 (viewport-meta bugs) are out of scope in v2;
`page.viewportMeta` is still recorded. Requests the page makes on its own during injection rounds are counted per
round (`injected.requests`: all, and to hosts other than the final host) for the audit.

Host order: within a group, hosts are in seeded hash order and domains are drawn with weight sqrt(hosts in the
domain), so a capped run is not almost all lovable.app; the groups are interleaved. With `--targets`, a shard stops
taking a group's hosts once its share of hosts with views is reached.

Safety: downloads refused, service workers blocked, popups and `window.open` closed, form `submit` cancelled by an
init script, dialogs dismissed, no typing, no clicks, no logins; a fresh context per host, closed after it, so
cookies and storage are never kept.

The v1 crawl (two loads per host, `genclass-vision/0.1`) and its validation run are described in
`results/README.md`.

### Output

Under `~/vision-out/crawl/shard-I/`, one set per process start (`T`):

- `views-T.jsonl.gz`: one line per view: `vid`, `host`, `group`, `builder`, `domain`, `device` (desktop, phone),
  `scheme` (light, dark), `inj`, `round` (0 for a clean view, else the injection round), `page` (below), `cost`
  (ms per extractor phase: page, walk, rows, hit, vars, total), `nav` (HTTP status, content type, final host, load
  and settle ms, console errors, page errors, failed requests, request count, `loadTimeout`, `redirectedOff`),
  `injected` (null, or `{env, round, final, recipes, partial, pre, undo, pix}`, below), `shot` (bytes). The `vid`
  of an injected view ends in `-rN`.
- `elements-T.jsonl.gz`: one line per element row: `{vid, ...row}`.
- `shots/<host>/<device>-<scheme>[-rN].jpg` (on the node only).
- `crops/<id>.jpg` and `crops/<id>.json`: the labelling candidates of natural views (on the node only;
  [Candidates for labelling](#candidates-for-labelling)).
- `done-T.jsonl`: `{host, group, status, ms, views, error, dark, inject, rounds, crops, drift, notApplied}`;
  `stats-T.json` at the end (hosts, views, crops, rounds, faults and controls applied, faults per family, recipes
  with a trace, undo drift, pixel checks, requests during rounds, hosts skipped by the final robots check).

`vid` is the first 12 hex of SHA-1 of host, device and process start, then the scheme and `-rN`: it names a view
without naming the host. `nav` also holds `roundRequests`, `roundOffHost`, `clientNav`, `clientRedirect`.

`page` fields: viewport and DPR, `vvScale`, document `scrollW`/`scrollH`/`clientW` (sideways scroll), parsed
`viewportMeta` (`present`, `deviceWidth`, `fixedWidth`, `initialScale`, `maxScale`, `userScalableNo`,
`zoomBlocked`), `colorScheme`, `prefersDark`, `appDark` (html.dark or data-theme), `reducedMotion`, `forcedColors`,
html and body backgrounds, body colour, font and size, `canvas` (the colour behind everything), `fonts`
(`[family, loaded, error, pending]` per declared family), `fontsStatus`, `sheets` (count, inline, same, cross,
unreadable, rules, adopted, link elements, links with no sheet), `res` (resource timing: count, bytes, responses
of 400 or more by type), `fp` (builder and framework fingerprints such as lovable, base44, v0, next, vite, radix,
tailwind-play-cdn), `animations` (running), element counts (`elements`, `rendered`, `rows`, `truncated`),
`varRules`, `varUndef`, `varInvalid`, `textInView`, `visInView`, `hitTargets`, `stackReads`, `lab` (a page-level
fault label).

### Element rows

One row per rendered element (border box with area, or labelled), document order; when a view has more than
`--max-rows`, labelled rows are kept first, then visible ones in the viewport, then other visible ones. Keys are
left out when they hold the default shown.

| key | meaning (default when absent) |
|---|---|
| `i`, `p`, `d` | row index, parent row index (-1), DOM depth |
| `tag`, `role` | tag name; explicit or implicit ARIA role ("") |
| `lab` | the recipe ids that labelled the element, space-separated, from the injection runtime's WeakMap (none) |
| `made` | 1 when a recipe created the element (bookkeeping for build_set.mjs, never a feature) |
| `x`, `y`, `w`, `h` | border box in CSS px, viewport coordinates at scroll 0 |
| `inv` | share of the box inside the viewport, 0 to 1 |
| `vis`, `why`, `sr` | VISUAL.md 2.1 `visible()`, the reason when 0 (visibility, opacity, check, tiny, aria-hidden, details, sr-only, display-none), screen-reader-only flag |
| `ia`, `cur`, `pen`, `dis`, `foc` | interactive (native, role, onclick, tabindex, contenteditable), cursor pointer, pointer-events none, disabled, focusable (0) |
| `pos`, `disp` | position (r, a, f, s; static), display (block) |
| `tl`, `tt`, `ln`, `tspill` | own text length, textContent length, lines of the first text node, px the text box spills out of the element box (0) |
| `fs`, `fw`, `lh` | font size px, weight (400), line height px (-1 for normal) |
| `ff`, `fst` | first font family; its state: l loaded, e error, p loading, u unloaded, s no FontFace (system), g generic |
| `tsh`, `nw`, `ell`, `lcl`, `ta` | text-shadow, nowrap, text-overflow ellipsis, line clamp, text-align (start) |
| `c`, `bg`, `bgi`, `bclip`, `tfc` | text colour RGBA; own background RGBA (transparent); background image 1 url, 2 gradient, 3 both; background-clip text; -webkit-text-fill-color when it differs |
| `eb`, `ebs` | effective background along the ancestor chain (alpha composited), status 0 solid, 1 canvas, 2 image or gradient, 3 replaced element, 4 filter or blend, 5 unparsed colour |
| `cr` | WCAG 2.2 contrast of the text over `eb`, text alpha times `eop`, truncated to two decimals |
| `sb`, `sbs`, `scr` | the same from the paint stack at the box centre (`elementsFromPoint`, text in the viewport only); `sbs` adds 6 covered and 7 not in the stack |
| `op`, `eop`, `vsb` | own opacity (1), product of ancestor opacities (1), visibility (visible) |
| `ox`, `oy`, `sw`, `sh`, `cw`, `ch` | overflow per axis (v visible, h hidden, c clip, a auto, s scroll); scroll and client sizes when they differ or overflow is not visible |
| `nca`, `cvis` | clipping ancestors (0), share of the box left after their clip (1) |
| `cpath`, `clip` | clip-path, legacy clip |
| `z`, `sc`, `sca`, `ftrap` | z-index (auto); the reason it creates a stacking context; row of the nearest stacking-context ancestor (-2 when that ancestor is not a row); position fixed inside a transformed or filtered ancestor |
| `tf`, `flt`, `an` | transform, filter or backdrop-filter, a running animation on it or an ancestor |
| `hs`, `ho`, `ha`, `hn`, `hb` | of 5 `elementFromPoint` probes (centre and 15% insets): hit itself or a descendant, another element, an ancestor, nothing or outside the viewport; `hb` the row that covered it most |
| `nw`, `nh`, `cmp`, `iok`, `src`, `lazy`, `of`, `nosize`, `alt`, `dist` | img: natural size, complete, loaded, URL class (same, cross, data, blob, ph placeholder host, unsplash), loading lazy, object-fit, missing width or height attribute, alt length (-1 none), aspect distortion |
| `rs`, `verr`, `vb`, `wa`, `rw`, `bsrc` | video readyState and error, svg viewBox and width attribute, canvas or iframe width, background image URL class |
| `vu`, `vi`, `vp` | var() references with no value and no fallback; colour declarations invalid after substitution (`CSS.supports`); up to 3 property names |
| `lk` | leak patterns in the own text: `[[id, matched characters]]`, at most 24 characters per match |

Note that `nw` means nowrap on text rows and natural width on `img` rows (an img has no own text).

Never stored: page text, attribute values, URLs inside the page, form values, cookies. The leak excerpt is the
matched pattern only (for example `$NaN`, `{{ user.name }}`).

Labels never change extraction (v2): a labelled element gets the same row, the same hit tests and the same place
under the row cap as any other element, and an element with no box (inside `display: none`) has no row whether it
is labelled or not. v1 gave labelled elements hit tests, rows without a box and first place under the cap, each a
signal a model could read. The runtime's injected sheet is not counted in `page.sheets` (its rules are read by the
var() pass, so an undefined `var()` a recipe writes is measured like one in a page sheet).

Approximations, so training can weigh them: the clip rect treats absolutely positioned elements like in-flow ones;
the ancestor-chain background ignores positioned layers painted behind an element (the paint-stack columns cover
text in the viewport); the var() pass ignores the cascade (a later rule may override the declaration) and reads at
most 2,500 rules that use var().

## Fault injection

`inject.mjs` runs the recipes of `injectors.json` whose phase is `after-load` and whose env is Chromium (148 of 216
in the 2026-10-13 file), minus the 30 in `DROPPED`: 118 recipes (103 faults, 15 controls) in 13 families. Phone
recipes (touch, or a viewport under 600 px) run in the phone-size rounds. A recipe's emulation is mapped onto the
views the crawl has: only its colour scheme is kept (a dark round only on hosts that have natural dark views of the
same device); viewport sizes, classic scrollbars and reduced motion are not emulated. Recipes run as plain functions
in `page.evaluate` (no `eval`, so a page CSP cannot block them).

### Traceless (v2)

The recipes' operations are unchanged (they still write `el.style`, add bench-* classes, call `css()`); what they
write is moved before any page script runs. After each recipe returns, its MutationObserver records are drained
(`takeRecords()`, synchronous) and the scrubber:

- moves every inline style change on an existing element into a rule of the injected sheet for a structural
  selector of that element (the nearest ancestor with a unique id, else `body`, then `tag:nth-child(k)` steps), with
  `!important` so it wins as the inline style did, and restores the attribute; a declaration the recipe removed
  becomes a rule holding the value the page's sheets give without it;
- does the same for the inline styles of every node the recipe created, and removes the attribute;
- replaces `.bench-*` marker classes and `[data-bench-fault~="id"]` selectors in `css()` text by `:is(...)` of the
  structural selectors of the elements that carried them, and removes the classes;
- emulates any other class or data-* change (an unbacked Tailwind class, a renamed token) by the computed-style
  difference it made on the element and its descendants (at most 800 elements), written as rules, and restores the
  attributes;
- then checks that no style, class or data-* attribute differs from its value before the recipe, on any element it
  touched or created. A recipe that still leaves one gets `trace` (and `partial`), its labels are removed, and
  build_set.mjs drops the view.

The injected sheet is one `CSSStyleSheet` in `document.adoptedStyleSheets` (no node in the DOM). Its rules are written
again after every recipe and at the end of the round, so the `:nth-child` steps are those of the final DOM of the
round. Labels are a `WeakMap` (element -> recipe ids) the extractor reads; created elements are a `WeakSet`. Other
attribute changes are the fault itself and stay, reported per recipe in `attrs` and in `summary.json`
(`mechanismAttributes`): an svg without `viewBox` or `width`/`height`, a `disabled` button, a removed `aria-label`,
`aria-invalid`, `placeholder` instead of a label, a `title`. A recipe that throws (usually `NotApplicable` after an
early `css()` call) gets its `css()` text and rule deletions taken back; DOM changes it made before throwing make
the view `partial`. A recipe that ran but changed nothing (`n/a: nothing changed`) or marked nothing is not a fault.

`enableAppDarkMode()` no longer sets `html.dark`, `data-theme` or an inline `color-scheme`: the round runs under the
emulated `prefers-color-scheme: dark` and the recipe applies only when the page is dark on its own (the background at
the centre of the viewport has relative luminance under 0.18), else it is not applicable. `deleteRules()` no longer
walks into `@keyframes` (in v1 `keyframes-removed` deleted nothing).

Dropped from training (`inject.mjs` `DROPPED`, checked by `test/inject.test.mjs`):

| recipe | why |
|---|---|
| image-invented-unsplash, image-dead-placeholder-host | an img pointed at unsplash.com (third-party request) |
| embed-youtube-dead-id, control-embed-live-video, embed-rickroll-placeholder, control-embed-real-video | a YouTube embed (third-party) |
| embed-maps-placeholder-key, control-maps-query-embed | Google Maps image or embed (third-party) |
| video-source-dead-sample | a video on commondatastorage.googleapis.com (third-party) |
| video-autoplay-unmuted, control-video-muted-autoplay, control-video-controls | `load()`, `play()` or seeking fetch media; playback state cannot be undone |
| image-css-background-404, control-image-lazy-offscreen | a URL on the crawled host (an extra request to the site) |
| builder-badge-and-title | a favicon link to `/vite.svg` on the crawled host; edits the document title |
| bootstrap4-attrs-on-5, control-bootstrap-both-attrs | the fault is a data-* attribute rename with no effect at rest |
| shift-late-banner | a timer inserts and styles the banner after the scrubber ran; the undo cannot see it |
| reveal-threshold-unreachable, control-reveal-completes | an IntersectionObserver callback writes an inline style later |
| wheel-hijack | a wheel listener; nothing changes at rest |
| dark-variant-media-only | needs the app's dark class on the root element; nothing changes in a light view |
| rtl-flip | the `dir` attribute on the root element (page-level label only) |
| sticky-broken-wrapper | reparents every body child (depth and structure of the whole page change); only shows when scrolling |
| overflow-100vw-classic, scrollbar-double, control-scroller-scrollbar-visible | need classic scrollbars, which the crawl's Chromium never shows |
| breakpoint-small-range | exists only at 992 to 995 px wide |
| sticky-stack | a landscape phone (568x320) |
| motion-infinite-decoration | the fault is ignoring `prefers-reduced-motion: reduce`, which no view emulates |

`test/browser/traceless.mjs` (on a node) runs every trainable recipe on `test/browser/fixture.html` and fails when an
applied recipe leaves a style, class or data-* change, a created node with a style attribute or marker, an
unrestored page after the undo, or a request.

### Rounds

An injected host gets up to `--rounds` rounds per device size (6 phone, then 8 desktop). Each round picks 1 to 3
recipes with `chooseRound`: the first is a control with probability 0.15, else a fault whose family is drawn with
weight 1 / (faults of that family applied so far in this process + 3); the rest share the first one's colour scheme,
have distinct catalog ids and were not used earlier on the host. The crawl sets the round's colour scheme, takes a
full-resolution JPEG of the viewport, applies the recipes, settles, extracts the labelled view, measures the marked
boxes and takes a second JPEG. Then it undoes the round:

- Undo: the recipes' MutationObserver records replayed backwards (attributes, text, inserted and removed nodes),
  journaled CSSOM deletions re-inserted, `stylesheet.disabled` restored, `adoptedStyleSheets` restored and the
  injected sheet emptied, labels and created-element sets cleared. Recipes whose effect this cannot reverse
  (timers, listeners, media state, a lost WebGL context; `finalOnly` in inject.mjs) run only in the host's last
  round, which is not undone.
- Gate: after the undo, the scheme goes back to light, the window scrolls to the top, and the next round runs only
  if the undo threw nothing, the injected sheet is no longer adopted (`__visionResidue`) and the element count is
  within 2% of the count before round 1 of that size. The share of the first 400 element boxes that match the
  pre-round layout is stored as `injected.pre.same` on the next view; a host's `drift` lists the rounds that stopped
  it.

Pixel check (VISUAL.md section 15): in a blank comparator page (never the crawled page), the two JPEGs are compared
inside each marked element's box (the union of its box after injection and after the undo, clipped to the
viewport); a pixel changed when a channel differs by more than 32. `injected.pix` holds, per marked element, the
label, the box, the area in the viewport `a` and the changed pixels `n`, plus the changed pixels in the whole
viewport. build_set.mjs turns them into verdicts: `seen` (n at least 16 and at least 1% of the box), `unseen` (in
the viewport but no visible change: a NOI candidate, such as a focus style that needs the keyboard), `out` (outside
the viewport), with `noisy` when more than 5% of the viewport outside the boxes changed.

Labels: `injected.recipes` lists each recipe with `applied`, `marked`, `reason` (`n/a: ...` when no visible target
existed or nothing changed), `attrs`, and `trace` or `partial` when set; drop views with `partial`. Controls are
correct lookalikes: a report on a control target is a false report. The other phases (before-load, network, init,
on-interaction: 64 of 216 recipes) need a second load or real input on a live site, and 4 after-load recipes need
Firefox or WebKit; this crawl runs neither.

## The training set

`build_set.mjs` reads every `shard-*` under `--in` and writes to `--out`:

- Near-duplicate removal: hosts whose clean light view (desktop, else phone) has the same layout fingerprint (tag
  and 16 px quantized box of the first 150 visible rows) form a cluster; only the representative host (lowest
  SHA-1) goes into the matrices. This is coarser than the ORB similarity CATALOG.md cites, and catches identical
  templates, not restyled ones.
- Splits by representative host: SHA-1 of `seed|host`, first byte under 205 train, under 230 val, else test.
- `X-<split>.f32` (float32, `F` columns, `schema.json` names them: numeric row keys with the README defaults,
  derived overflow, colour and image columns, categorical codes, eight page columns; F = 110 in v2, v1 had 112 with
  `pRound` and `pFontsLoaded`) and `meta-<split>.jsonl.gz`, one
  line per matrix row: `{v, i, y}` with `y` = `nat` (element of a clean view, label unknown, mostly negative),
  `clean` (unlabelled element of an injected view, at most `--clean-per-view` 40 per view, seeded), `fault` (with
  recipe ids `r`, families `f`, catalog ids `c`, label attributes `a`, pixel verdict `pv`, `pa`, `pn`, `noisy`)
  or `control` (marked only by a control recipe: a hard negative). Natural rows carry `n`, a bitmask of the
  measured signals (1 broken image, 2 template leak, 4 text under 1.5:1 on a solid background, 8 placeholder image
  host, 16 undefined var()).
- `views.jsonl.gz`: one line per view with its index `v`, split, cluster, applied recipes, page-level labels
  (`attribute: page` recipes label the page, not a row), the page facts and the natural signals.
- `summary.json`: crawl success by group, views by device and scheme, extractor cost, faults per family and
  recipe, pixel verdicts per family, natural-signal prevalence by group, device and scheme. The run's copy is in
  `results/`.

Style, script, link, meta, head, title, noscript and template rows are left out of the matrices, and so are rows
without a box and, in injected views, rows of elements a recipe created and did not label (`made`; counted as
`madeRowsSkipped`). Views with `partial` set (a recipe threw after changing the page, or left a trace) are dropped.
`summary.json` also has, under `injection`, `tracedViews`, `tracedRecipes`, `mechanismAttributes`,
`roundRequests`, `roundRequestsOffHost` and `recipesDropped`.

## Provenance audit

`train/provenance.py`, after build_set.mjs and before any training script:

- Columns removed because they record how a view was made: `pRound` (the injection round) and `pFontsLoaded` (fonts
  finish loading with time, and injected views always come later than natural ones). `pVw`, `pVh` and `pDark` stay
  in the matrix for the rules and the relative box, and stay out of the model inputs, as in v1. No column counts
  attributes, inline styles or injected nodes; rows of nodes a recipe created and did not label are not used.
- The audit: positives are the `clean` rows (unlabelled elements of injected views), each matched with a natural
  row of the natural view of the same host, device and scheme (seeded). Same page, same emulation: what is left to
  separate them is what injection changed (a trace, undo drift, the time since load). LightGBM (31 leaves, early
  stopping on val by AUC) on the model inputs, fit on train hosts; ROC AUC on val and test hosts.
- Recipes with a page-wide effect (`inject.mjs` `SPREAD`, 20 recipes: every stylesheet disabled, the root or body
  font size, a page that scrolls sideways, a reflowed or hidden app root, a fixed overlay over everything, a
  restyled subtree) change elements they do not label. Their views keep their labelled rows and page labels, and
  give no clean rows (`spreadCleanRowsSkipped` in `schema.json` and `summary.json`). Such elements are neither true
  negatives nor a fair provenance check. The list comes from the first v2 audit, which failed at 0.657: desktop dark
  views were at chance, the top inputs were `fs` and `pSideways`, and these 20 recipes had a per-recipe AUC of 0.577
  to 0.977 over views where they were the only recipe applied (every other recipe 0.47 to 0.57). With `SPREAD` the
  audit gives 0.528 (`results/v2/README.md`).
- Gate: `provenance.json` with `auc` = max(val AUC, test AUC) and `pass` = auc under 0.55; exit code 3 when it
  fails. `train_gbt.py` and `train_mlp.py` stop unless it passed (`--skip-provenance-gate` exists for debugging and
  marks results as not counting). The report lists the inputs by gain, the 15 single inputs that separate the two
  classes best, AUC per device and scheme, AUC per recipe over the views that applied it (`byRecipe`) and over
  the views where it was the only recipe (`byRecipeSolo`), and an unmatched variant (any natural view of the same
  host) for reference.

## Candidates for labelling

On every natural view (never injected), `crawl.mjs` saves up to 6 element crops (`src/candidates.mjs`):

- the top-scoring elements of the v1 `gbt-small` model (`results/train/gbt-small.json`, scored in node with the frozen
  v1 encoder and `train/gbt.mjs`; inputs as in v1, with `pDesktop` 0 for phone views);
- every element the v1 rules flag (`train/common.py` `rules`, ported to raw rows);
- 2 random visible elements.

Only elements at least 4 x 4 px, visible and at least partly in the viewport can be cropped (html and body never).
Order of choice: up to 2 rule flags, the top 2 by score, 2 random, then the remaining rule flags and elements
scoring at least 0.208 (the v1 gbt-small `frr-1%` threshold) alternately while slots last. An element chosen by more
than one source lists them all. The crop is the element's box with 24 px of context, clamped to the viewport, cut
from a PNG of the viewport in the blank comparator page and saved as JPEG quality 0.9.

Each crop is `crops/<id>.jpg` with `crops/<id>.json`: `id` (`c` + 12 hex of SHA-1 of the view id and row index: no
host), `vid` and `i` (the element row: `elements-T.jsonl.gz` has `{vid, i, ...}`, and build_set.mjs `meta` has the
view index `v` of that `vid` and `i`), `sources`, `family` (the rule's family, else a guess from the tag, hit tests,
overflow and contrast, else null), `rules`, `score`, `tag`, `role`, `box`, `crop`, `inCrop` (the element's box inside
the crop), `device`, `scheme`, `group`, `domain` (the hosting domain such as lovable.app, never the host).

`label/sheets.py` tiles them on the node: seeded shuffle (a sheet mixes pages and sources), 12 per sheet (3 x 4),
PNGs about 1,400 px wide, each cell numbered 1 to 12 with its crop id over the crop and a thin magenta frame just
outside the element. Nothing on a sheet or in `index.json` says which source chose a crop or the model's score, so
labelling is blind; `labels.csv` (id, sheet, cell, label, note) is the form to fill (real, unclear or not).
`--quota rules=800,gbt=700,random=700` keeps a stratified subset (a crop counts for the first of its sources in that
order), `--per-view 2` keeps at most 2 crops per page and device, and `--views <trainset>/views.jsonl.gz --splits
val,test` keeps only crops of held-out hosts that are not near-duplicates, so a labelled page was never a training
page. `selection.json` has the counts per stratum and split, not which crop is which.

## Test

```bash
cd vision && npm test     # node --test test/*.test.mjs; no browser, no network
python3 -m unittest discover -s vision/label -p 'test_*.py'    # from the repo root; Pillow
python3 -m unittest discover -s vision/train -p 'test_*.py'    # numpy only, no model is trained
```

On a node, with Chromium: `node test/browser/traceless.mjs` ([Fault injection](#fault-injection)).
