# Visual crawl v2: training set, provenance audit, labelling sheets (2026-10-14)

Summaries of the v2 run (branch `wave2/visual-v2`). Raw data is not in git. It stays on the c20 OS disk under
`~/vision-out/v2`: `discover`, `crawl` (four shards, 3.6 GB with screenshots and crops), `trainset`,
`models/provenance*.json`, `sheets`, `sheets-train`, `labels*.json` (with hosts and notes), `models/v2` and `models/v2b`
(run A and run B), `handcheck` and `export`. No file here names a crawled host.

| file | what |
|---|---|
| `summary.json` | written by `src/build_set.mjs`: crawl success, views, extractor cost, faults per family and recipe, pixel verdicts, trace and request counts, SPREAD views, natural-signal prevalence, near-duplicate clusters, training-set counts |
| `provenance.json` | written by `train/provenance.py` on the final training set: the audit that gates training (pass) |
| `provenance-run1.json` | the same audit on the first build, before `SPREAD` (fail); its `byRecipeSolo` table chose `SPREAD` |
| `TRAINING.md` | the v2 models trained and judged on labelled real pages: labels, method, results, hand check, export, ship decision |
| `labels.json` | the 2,200 labelled crops of held-out hosts (6 labellers), resolved: crop id, split, verdict, family, votes, device, scheme, group, stratum, v1 rules; no host, no notes |
| `labels-extra.json` | the 420 training-only crops of train hosts (labelled by the training agent), same fields |
| `handcheck-hc1.json`, `handcheck-hc2.json`, `handcheck-hc3.json` | the blind hand checks of flags outside the labelled set: counts per source (no hosts) |
| `train/eval-v2.json`, `train/train.json`, `train/search.json` | the final run (B, with the training-only labels): every evaluation number, training rows and settings, the random search |
| `train/run-a/` | the same for run A (no training-only labels) |
| `train/visual-v2.json`, `train/export-v2.json` | the shipping bundle (format genclass-visual-2, read by `train/detect_v2.mjs`) and its sizes, parity and cost |
| `visual-model.draft.json` | a draft model block for `site/src/data/visual.json`: measured numbers only |
| `counts.json` | discovery by hosting domain, crawl statistics summed over the shard processes, host status by group, crop counts by source, the in-browser traceless check, training-set counts, the contact-sheet selection |

## Run

1. Nodes c20 to c23 (F80ads_v7). The in-browser check `test/browser/traceless.mjs` on c20 first: 118 trainable recipes,
   116 applied on the fixture, 2 not applicable there (glass-over-light, mobile-nav-no-toggle), 0 failed (no trace
   left, every undo restored the page, no request).
2. Discovery on c20 over nine Common Crawl crawls (CC-MAIN-2026-04 to 2026-39) with `--crawls 9 --ai-hosts 40000
   --control 5000`: 24,993 AI-builder hosts (v1: 21,807 over six crawls) and 4,334 control hosts from the Tranco list
   N26LW.

   | domain | hosts found | hosts with views |
   |---|---:|---:|
   | lovable.app | 15,425 | 2,634 |
   | base44.app | 3,429 | 1,105 |
   | replit.app | 2,647 | 723 |
   | manus.space | 1,966 | 627 |
   | created.app | 1,183 | 705 |
   | emergent.host | 118 | 77 |
   | vusercontent.net (v0) | 103 | 103 |
   | mocha.app | 84 | 0 |
   | genspark.space | 24 | 24 |
   | windsurf.build | 14 | 13 |
   | control (Tranco top 100k) | 4,334 | 1,209 |

   Hosts are taken in seeded hash order with domains drawn by weight sqrt(hosts); mocha.app had none with views
   (its hosts failed or were skipped).
3. Crawl, 01:53 to 02:30 UTC, one page load per host, 56 workers per node, shard i of 4 on the i-th node:
   `node src/crawl.mjs --urls ~/vision-out/v2/discover/urls.jsonl --out ~/vision-out/v2/crawl --shard I/4 --workers 56
   --inject 1 --groups ai-builder,control --targets ai-builder=6000,control=1200` (a 24-host smoke run of shard 0 went
   first into the same output, so the full run skipped those hosts instead of loading them again). User agent
   `genclass-vision/0.2 (+https://genclass.dev/security)`.
4. Shards 1 to 3 copied to c20 over the VNet (file count, bytes and SHA-1 of the data files checked), then
   `build_set.mjs` (227 s), `train/provenance.py` (26 s) and `label/sheets.py` on c20.

## Crawl

| group | hosts attempted | with views | skipped by robots.txt | not HTML, HTTP error or failed |
|---|---:|---:|---:|---:|
| AI-builder | 7,104 | 6,011 (6,003 ok, 8 partial) | 233 (85 disallowed, 125 unreachable, 23 disallowed for the final host) | 860 |
| control | 2,054 | 1,209 (1,208 ok, 1 partial) | 600 (39 disallowed, 545 unreachable, 13 for the final host, 3 5xx) | 245 |

Views: 19,198 natural (desktop light 7,220, phone light 7,220, desktop dark 2,379, phone dark 2,379: the seeded third
of hosts) and 64,784 injected; 31,864,620 element rows. Time per host with injection rounds: p50 48 s, p90 75 s.
Extractor cost per view p50 18.6 ms, p90 62.5 ms, p99 234 ms; rows per view p50 229, p90 926; 1,522 views hit the
2,500-row cap.

## Injection

99,472 rounds; 86,801 fault applications and 5,444 controls in the views kept; 1,160 views dropped as partial (a
recipe changed the page and then threw or marked nothing). Traces the scrubber could not remove: 6 views
(tw-config-tokens-missing 4, class-subtree-unbacked 2), dropped with the partial ones. The undo gate stopped 161
loads; layout match after an undo (`injected.pre.same`) p10 0.97, p50 1.0 (v1, two loads per host: p10 0.51).

| family | faults applied | recipes | labelled rows (a row with two families counts in both) | pixel seen | unseen | outside viewport |
|---|---:|---:|---:|---:|---:|---:|
| responsive | 12,242 | 8 | 8,162 | 3,399 | 473 | 4,290 |
| overflow | 11,569 | 11 | 11,340 | 4,216 | 324 | 6,800 |
| text | 9,469 | 10 | 5,591 | 1,961 | 225 | 3,405 |
| controls | 7,557 | 14 | 42,547 | 5,983 | 7,217 | 29,347 |
| media | 7,475 | 6 | 5,166 | 2,566 | 436 | 2,164 |
| occlusion | 6,315 | 7 | 6,250 | 4,340 | 659 | 1,251 |
| blank | 5,330 | 6 | 2,766 | 1,208 | 170 | 1,388 |
| leaks | 5,247 | 5 | 5,322 | 1,471 | 55 | 3,796 |
| design | 5,045 | 5 | 9,010 | 3,327 | 501 | 5,182 |
| styles | 4,813 | 12 | 25,869 | 4,536 | 4,408 | 16,924 |
| other | 4,535 | 9 | 19,696 | 2,705 | 2,485 | 14,506 |
| motion | 4,461 | 5 | 6,682 | 1,588 | 660 | 4,434 |
| dark | 2,743 | 4 | 2,707 | 352 | 53 | 2,302 |
| total | 86,801 | 102 | 151,108 | 37,652 | 17,666 | 95,789 |

Requests the pages made on their own while rounds ran (no recipe requests anything; these are the pages' own
timers, beacons and lazy loads): 58,919 in the injected views kept, 52,844 of them to hosts other than the final
host; 131,556 over all round phases including rounds that applied nothing. Recipes never applied:
video-no-playsinline-ios, webgl-context-lost, engine-gated-shift, radius-transform-safari, bg-fixed-hero.

## Training set

F = 110 columns (`vision-trainset-2`). Near-duplicate removal: 6,971 layout clusters over 7,177 fingerprinted hosts,
206 hosts dropped from the matrices (largest cluster 67).

| split | hosts | views | nat | clean | fault | control |
|---|---:|---:|---:|---:|---:|---:|
| train | 5,575 | 56,836 | 5,249,035 | 1,058,187 | 121,521 | 3,928 |
| val | 700 | 7,097 | 657,424 | 133,614 | 15,019 | 465 |
| test | 699 | 7,099 | 698,865 | 131,832 | 14,052 | 506 |

Left out: 171,346 rows of elements a recipe created and did not label (`made`), and every unlabelled row of the
28,136 injected views that applied a `SPREAD` recipe (9,771,121 rows before the 40-per-view sampling of clean rows).

## Provenance audit

Clean rows of injected views (1) against natural rows of the same host, device and colour scheme (0), LightGBM on
the model inputs, trained on train hosts, ROC AUC on val and test hosts; pass under 0.55.

| build | AUC val | AUC test | desktop light | desktop dark | phone light | result |
|---|---:|---:|---:|---:|---:|---|
| run 1: every injected view gives clean rows | 0.657 | 0.653 | 0.583 / 0.590 | 0.492 / 0.502 | 0.707 / 0.697 | fail |
| final: no clean rows from `SPREAD` views | 0.527 | 0.528 | 0.524 / 0.526 | 0.511 / 0.513 | 0.533 / 0.533 | **pass** |

(per view: val / test.) Phone dark has no pairs: the four trainable dark recipes are desktop recipes.

Run 1 was not a trace of the injection mechanics. Desktop dark views separated at chance (0.49 to 0.50), and the
model's top inputs were `fs` (gain share 0.31) and `pSideways` (0.21): the font size of every element and whether
the page scrolls sideways. Both are page-wide effects of some faults. The AUC over views where a single recipe was
applied (`byRecipeSolo`) put 20 recipes at 0.577 to 0.977: stylesheets-disabled 0.977, text-scale-200 0.952, nine
recipes that make the page scroll sideways 0.68 to 0.92 (seven overflow and blowout recipes, layout-fixed-sidebar,
layout-grid-fixed-columns), text-tiny-mobile 0.889, blank-root-emptied and
blank-root-hidden 0.70 and 0.65, icon-shrink 0.635, vite-template-centering 0.616, class-subtree-unbacked 0.600,
jank-blur-stack 0.586, overlap-clone-offset 0.579, popup-no-focus 0.577. The other recipes were at 0.47 to 0.57. These
20 recipes change elements they do not label, so the unlabelled elements of their views are neither true negatives
nor a fair provenance check. `inject.mjs` `SPREAD` lists them with their run-1 AUC. `build_set.mjs` keeps their
labelled rows and page labels and gives their views no clean rows.

Final audit: 398,225 / 133,206 / 131,425 pairs (train / val / test) over 5,417 / 680 / 681 hosts, 201 trees. Top gain:
`cat_tag` 0.09, `x` 0.06, `eop` 0.047, `br` 0.045, `an` 0.036. The best single input separates at 0.506 (`nca`), then
`an` 0.504 and `pSideways` 0.504. The highest remaining per-recipe AUCs: sidebar-zero-width 0.566 (500 pairs),
fixed-footer-over-cta 0.565 (12,067), fake-clickable-card 0.563 (492). The unmatched reference (natural rows of any
view of the same host) is 0.61 because it mixes devices and schemes. It does not gate.

## Labelling candidates and contact sheets

The crawl cut 83,402 crops on 19,009 natural views, chosen by the v1 gbt-small model's top scores, the v1 rules and at
random. Crops chosen by gbt only: 38,565. Random only: 37,446. Rules only: 4,893. Gbt and rules: 2,173. Random and
rules: 216. Gbt and random: 108. All three: 1. By device: desktop 42,454, phone 40,948. By scheme: light 62,656, dark
20,746. By group: AI-builder 67,520, control 15,882.

Sheets on c20, `~/vision-out/v2/sheets`: `label/sheets.py --crops ~/vision-out/v2/crawl --out ~/vision-out/v2/sheets
--seed 3 --quota rules=800,gbt=700,random=700 --per-view 2 --views ~/vision-out/v2/trainset/views.jsonl.gz --splits
val,test`. That gives 2,200 crops on 184 sheets (12 per sheet, 1,398 px wide, 78 MB). The crops come only from val and
test hosts that are not near-duplicates (val 1,086, test 1,114), so no labelled page was ever a training page. The
strata are 800 crops a v1 rule flagged, 700 the v1 model chose and no rule flagged, and 700 random. Each page and
device gives at most 2 crops. `index.json` and the sheets do not show the source; `selection.json` holds only the
stratum counts. `labels.csv` (id, sheet, cell, label, note) is the form to fill with real, unclear or not. The crop
sidecars (`crawl/shard-*/crops/<id>.json`) join each id to its view, row and sources.
