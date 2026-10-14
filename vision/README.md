# vision: training data for visual checks

Status: data pipeline, 2026-10-13. Nothing here ships: `vision/` is not a root workspace, has its own
`package.json` and lockfile (generated on a cluster node), and is not in any package's `files`. It feeds the visual
checks designed in `docs/runtime/VISUAL.md` (branch `wave2/visual`) and uses the bug catalog and fault recipes in
`research/visual/` (`CATALOG.md`, `injectors.json`). The network model and its text (`situation-v2.3`) are not
touched.

The first full run (2026-10-14: 3,000 AI-builder and 600 control homepages, 35,074 injected faults in 13
families, a 4.0M-row training set and a sanity baseline) is summarised in `results/README.md`; its raw data is on
c20 in `~/vision-out`.

Everything that loads a browser or queries Common Crawl runs on a cluster node, never on the Mac. The only thing
meant for the Mac is the browser-free test (`npm test`).

## Pieces

| file | runs | what |
|---|---|---|
| `src/discover.mjs` | node | URL lists from the Common Crawl URL index: one homepage per host on AI-builder hosting domains, sampled general hosts, and a Tranco control sample |
| `src/crawl.mjs` | node | Playwright Chromium (headless shell), many contexts in parallel: robots.txt, two device loads per host, light and dark views, extraction, screenshots, optional fault injection |
| `src/extract.js` | in the page | the per-element feature extractor (classic script, no imports) |
| `src/inject.mjs` | node and page | applies `research/visual/injectors.json` recipes to the crawled page and labels the elements |
| `src/robots.mjs` | node | robots.txt rules (RFC 9309 matching) |
| `src/build_set.mjs` | node | the training set from merged crawl shards: near-duplicate removal, host splits, feature matrices, labels, pixel verdicts, `summary.json` |
| `train/baseline.py` | node | a sanity baseline on the training set (scikit-learn, the jev venv on the node) |
| `results/` | | summaries copied from the node (no raw data) |
| `scripts/node_setup.sh` | node | Node 22.22.0 (checksum verified), `npm ci`, Playwright Chromium and its system libraries, `~/vision-out` |
| `scripts/cluster.sh` | Mac | `sync`, `setup`, `exec`, `crawl`, `status` over ssh, hosts from `~/.jev-local/azure_hosts` |
| `test/extract.test.mjs` | anywhere | colour parsing, contrast, background resolution, leak patterns, viewport meta, var() substitution, robots rules, CDX parsing, recipe compilation, with fixtures in `test/fixtures/` |

## Running on a node

From the Mac (bash, not zsh: zsh eats the colon in `user@$IP:dir/`):

```bash
# 1. claim the nodes first (protocol below), then
bash vision/scripts/cluster.sh sync  "c20 c21 c22 c23"   # vision/ and research/visual/ to ~/gcl/
bash vision/scripts/cluster.sh setup "c20 c21 c22 c23"   # detached; log in ~/vision-setup.log ("setup ok on ...")
# 2. discovery on one node (about 35 s with the ZipNum files), then copy urls.jsonl to the others
bash vision/scripts/cluster.sh exec c20 'node src/discover.mjs --crawls 6 --ai-hosts 30000'
# 3. the crawl: shard i of N on the i-th host, detached; resumes from done-*.jsonl when restarted
bash vision/scripts/cluster.sh crawl "c20 c21 c22 c23" --workers 56 --inject 1 --groups ai-builder,control \
  --targets ai-builder=3000,control=600
bash vision/scripts/cluster.sh status "c20 c21 c22 c23"
# 4. copy every shard to the node that will train (inside the VNet), then on that node:
#    node --max-old-space-size=24000 src/build_set.mjs --in ~/vision-out/crawl --out ~/vision-out/trainset
```

On a node directly: `cd ~/gcl/vision && node src/crawl.mjs --urls ~/vision-out/discover/urls.jsonl --shard 0/4`.
Flags: `--workers` (default 60% of vCPUs), `--per-browser 8` (contexts per Chromium process), `--limit`,
`--inject` (share of loads that get injection rounds, default 0.35), `--rounds desktop=8,phone=6` (rounds per load),
`--targets ai-builder=3000,control=600` (hosts with views per group across all shards; each shard takes its share
and stops taking that group when full), `--dark-share 0.333` (hosts whose phone load also gets a dark view),
`--pixel false` (skip the pixel check), `--seed`, `--timeout 15000` (per load), `--max-rows 2500` (per view),
`--groups ai-builder,mixed-host,control`, `--shots false`.

Cluster rules that apply (`internal/training/NEEDS.md` has the claim table): check other agents' processes and take
the `~/.gcl-claim` lock on each node before using it; run `az` one call at a time with `--query` and `timeout 120`;
release the lock and deallocate every node you started when the stage ends. The 03:00 UTC auto-shutdown is the
backstop, not the plan.

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

Per host: robots.txt for the token `genclass-vision` (else `*`); a disallowed `/`, a 5xx or no answer skips the host.
Then two loads of the homepage, desktop (1366x768, DPR 1) and phone (390x844, `isMobile`, touch, DPR 3), because the
viewport meta, `hover` and `pointer` media only apply in a mobile context; the task asked for one load per host, and
a single desktop load resized to 390 px would hide the viewport-meta bugs (catalog entries 3 and 11, tier A).
Nothing else is requested from the host: no links followed, no reloads, the colour scheme switched in place.

Each load: `goto` with a 15 s cap (if `load` does not fire, whatever committed is measured), then fonts ready
(3 s cap) and 500 ms without DOM mutations (5 s cap), then the light view. The phone load of a seeded third of the
hosts (`--dark-share`) also gets the dark view (`emulateMedia` dark, a 1.5 s settle); desktop loads are light only.
Each view is extracted and screenshotted (viewport only, JPEG quality 55, 683x384 desktop and 293x633 phone). On a
seeded share of loads (`--inject`), injection rounds follow (Fault injection below), each with one more view.

Host order: within a group, hosts are in seeded hash order and domains are drawn with weight sqrt(hosts in the
domain), so a capped run is not almost all lovable.app; the groups are interleaved. With `--targets`, a shard stops
taking a group's hosts once its share of hosts with views is reached.

Safety: downloads refused, service workers blocked, popups and `window.open` closed, form `submit` cancelled by an
init script, dialogs dismissed, no typing, no clicks, no logins; a fresh context per load, closed after it, so
cookies and storage are never kept. The user agent carries `genclass-vision/0.1`.

Validation run on c20 (shard 3/16, first 120 hosts, 32 workers, `--inject 1`, 2026-10-13): 118 s; 100 hosts ok,
11 skipped by robots (8 unreachable, 2 disallowed, 1 5xx), 8 failed or empty (an HTTP/2 error, non-HTML or error
status), 1 partial (a hard timeout in the second load); 545 views. Per host p50 11.2 s and p90 26.1 s for both loads. Extraction per view p50
24 ms, p90 73 ms, max 237 ms; rows per view p50 306, 3 of 545 views hit the 2,500 cap. Output 16 MB, of which
screenshots 11 MB. The run's files are kept in `c20:~/vision-out/smoke2/shard-3` for building a loader.

### Output

Under `~/vision-out/crawl/shard-I/`, one set per process start (`T`):

- `views-T.jsonl.gz`: one line per view: `vid`, `host`, `group`, `builder`, `domain`, `device` (desktop, phone),
  `scheme` (light, dark), `inj`, `round` (0 for a clean view, else the injection round), `page` (below), `cost`
  (ms per extractor phase: page, walk, rows, hit, vars, total), `nav` (HTTP status, content type, final host, load
  and settle ms, console errors, page errors, failed requests, request count, `loadTimeout`, `redirectedOff`),
  `injected` (null, or `{env, round, final, recipes, partial, pre, undo, pix}`, below), `shot` (bytes). The `vid`
  of an injected view ends in `-rN`.
- `elements-T.jsonl.gz`: one line per element row: `{vid, ...row}`.
- `shots/<host>/<device>-<scheme>[-rN].jpg`.
- `done-T.jsonl`: `{host, group, status, ms, views, error, dark, rounds, drift, notApplied}`; `stats-T.json` at the
  end (hosts, views, rounds, faults and controls applied, faults per family, undo drift, pixel checks).

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
| `lab` | `data-bench-fault` value: space-separated recipe ids (none) |
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

Never stored: page text, attribute values other than `data-bench-fault`, URLs inside the page, form values,
cookies. The leak excerpt is the matched pattern only (for example `$NaN`, `{{ user.name }}`).

Approximations, so training can weigh them: the clip rect treats absolutely positioned elements like in-flow ones;
the ancestor-chain background ignores positioned layers painted behind an element (the paint-stack columns cover
text in the viewport); the var() pass ignores the cascade (a later rule may override the declaration) and reads at
most 2,500 rules that use var().

## Fault injection

`inject.mjs` runs the recipes of `injectors.json` whose phase is `after-load` and whose env is Chromium (148 of 216
in the 2026-10-13 file: 124 faults, 24 controls). Phone recipes (touch, or a viewport under 600 px) run in the phone
load. Recipes run as plain functions in `page.evaluate` (no `eval`, so a page CSP cannot block them); `css()` falls
back to a constructed sheet when a CSP blocks inline style elements.

Rounds: an injected load gets up to `--rounds` rounds (8 desktop, 6 phone). Each round picks 1 to 3 recipes with
`chooseRound`: the first is a control with probability 0.15, else a fault whose family is drawn with weight
1 / (faults of that family applied so far in this process + 3), so families that rarely find a target are tried
more often; the rest share the first one's env, have distinct catalog ids and were not used earlier in the load.
The crawl sets the round's colour scheme, reduced motion and viewport, takes a full-resolution JPEG of the
viewport, applies the recipes, settles, extracts the labelled view, measures the marked boxes and takes a second
JPEG. Then it undoes the round:

- Undo journal: a MutationObserver on the document records every attribute, text and child-list change the recipes
  make; `takeRecords()` drains it as soon as the synchronous recipes return, before any page script can run, and
  `__visionUndo()` replays the records backwards and restores `adoptedStyleSheets`. Recipes whose effect the journal
  cannot see (CSSOM rule edits, `stylesheet.disabled`, timers, listeners, media playback state; `finalOnly` in
  inject.mjs, 11 of 148) run only in a load's last round, which is not undone.
- Gate: after the undo, the env goes back to the device default, the window scrolls to the top, and the next round
  runs only if the undo threw nothing, no `data-bench-fault` attribute is left and the element count is within 2%
  of the count before round 1. Pages also move on their own (reveal on scroll, carousels, resize handlers), so the
  share of the first 400 element boxes that match the pre-round layout is stored as `injected.pre.same` on the next
  view instead of gating; a host's `drift` lists the rounds that stopped a load.

Pixel check (VISUAL.md section 15): in a blank comparator page (never the crawled page), the two JPEGs are compared
inside each marked element's box (the union of its box after injection and after the undo, clipped to the
viewport); a pixel changed when a channel differs by more than 32. `injected.pix` holds, per marked element, the
label, the box, the area in the viewport `a` and the changed pixels `n`, plus the changed pixels in the whole
viewport. build_set.mjs turns them into verdicts: `seen` (n at least 16 and at least 1% of the box), `unseen` (in
the viewport but no visible change: a NOI candidate, such as a focus style that needs the keyboard), `out` (outside
the viewport), with `noisy` when more than 5% of the viewport outside the boxes changed.

Labels: every marked element carries `data-bench-fault` with the recipe id, so element rows of the injected view
carry `lab`; `injected.recipes` lists each recipe with `applied`, `marked` and `reason` (`n/a: ...` when no visible
target existed). A recipe that changed the page and then threw gets its labels removed and sets
`injected.partial`; drop those views. Controls are correct lookalikes: a report on a control target is a false
report.

`class-unbacked-token` still throws when the picked element has no numeric shade class (for example
`bg-background`); it is recorded as an error, not a fault. The other phases (before-load, network, init,
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
  derived overflow, colour and image columns, categorical codes, ten page columns) and `meta-<split>.jsonl.gz`, one
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

Style, script, link, meta, head, title, noscript and template rows are left out of the matrices. Views with
`partial` set are dropped.

## Test

```bash
cd vision && npm test     # node --test test/*.test.mjs; no browser, no network
```
