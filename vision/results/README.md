# Visual crawl and training set, 2026-10-14

Summaries of one run of the vision pipeline. Raw data is not in git: it stays on c20 (`~/vision-out/crawl`, 942 MB in
four shards, and `~/vision-out/trainset`, 1.8 GB), on the OS disk, so it survives deallocation.

| file | what |
|---|---|
| `summary.json` | written by `src/build_set.mjs`: crawl success, views, extractor cost, faults per family and recipe, pixel verdicts, natural-signal prevalence, near-duplicate clusters, training-set counts |
| `schema.json` | the training set's feature names (F = 112), categorical vocabularies, label and verdict definitions |
| `baseline.json` | written by `train/baseline.py`: the sanity baseline below |

Run: branch `wave2/visual-data`; the crawl ran at 41f31c2, `build_set.mjs` and `train/baseline.py` at the commit
that adds this file. Crawl on c20, c21, c22 and c23 (F80ads_v7, 80
vCPU), 56 workers each, 2026-10-13 23:57 to 2026-10-14 00:14 UTC (807 to 890 s per shard). Command:

```bash
bash vision/scripts/cluster.sh crawl "c20 c21 c22 c23" --workers 56 --inject 1 --groups ai-builder,control \
  --targets ai-builder=3000,control=600
```

Shards 1 to 3 were copied to c20 over the VNet (sha1 checked), then `build_set.mjs` (105 s) and `train/baseline.py
--iters 1500 --neg 400000` (45 s) ran there.

## Crawl

| group | hosts attempted | with views | skipped by robots.txt | failed or empty | success |
|---|---:|---:|---:|---:|---:|
| AI-builder | 3,524 | 3,000 (2,978 ok, 22 partial) | 127 (84 unreachable, 43 disallowed) | 397 | 85% |
| control (Tranco top 100k) | 1,025 | 600 (599 ok, 1 partial) | 301 (266 unreachable, 31 disallowed, 4 5xx) | 124 | 59% |

Hosts with views by domain: lovable.app 1,434, base44.app 577, replit.app 375, manus.space 332, vusercontent.net
(v0) 98, created.app 87, emergent.host 63, genspark.space 23, windsurf.build 11, control 599 (desktop light views).

Views: 8,363 clean (desktop light 3,599, phone light 3,580, phone dark 1,184, that is 33% of phone loads) and
27,280 injected; 13,986,510 element rows. Time per host, both loads with injection rounds: p50 44 s, p90 75 s.

Extractor cost (`cost.total`, in the page): per view p50 21 ms, p90 67 ms, p99 238 ms, max 3,410 ms; per clean
load p50 31 ms, p90 84 ms. Rows per view p50 246, p90 929; 630 of 35,643 views hit the 2,500-row cap.

## Injected faults

35,177 fault recipes applied over 47,647 rounds (crawl stats), 35,074 of them in views kept for training (81 partial
views dropped), plus 2,310 controls. 123 of the 124 runnable fault recipes applied at least once; 42,575 recipe
attempts found no target (recorded as not applicable, not as faults). The undo gate stopped 457 loads early; 7
rounds threw. Layout match after an undo (`injected.pre.same`, share of the first 400 element boxes unchanged):
p10 0.51, p50 1.0.

| family | faults applied | recipes | labelled rows in matrices | pixel seen | unseen | outside viewport | baseline test recall |
|---|---:|---:|---:|---:|---:|---:|---:|
| responsive | 4,162 | 10 | 2,392 | 790 | 231 | 1,371 | 0.749 |
| text | 3,734 | 10 | 3,429 | 921 | 128 | 2,380 | 0.571 |
| overflow | 3,644 | 14 | 3,841 | 1,344 | 460 | 2,037 | 0.919 |
| controls | 2,900 | 14 | 19,187 | 2,493 | 3,975 | 12,719 | 0.343 |
| occlusion | 2,795 | 7 | 2,776 | 1,861 | 303 | 610 | 0.852 |
| media | 2,632 | 14 | 2,600 | 1,025 | 206 | 1,367 | 0.835 |
| other | 2,446 | 10 | 7,898 | 1,490 | 1,267 | 5,141 | 0.274 |
| motion | 2,297 | 8 | 2,845 | 721 | 242 | 1,882 | 0.901 |
| leaks | 2,292 | 7 | 2,440 | 801 | 251 | 1,387 | 0.812 |
| blank | 2,253 | 6 | 2,194 | 938 | 89 | 1,167 | 0.779 |
| styles | 2,131 | 13 | 12,349 | 2,286 | 2,050 | 8,013 | 0.374 |
| design | 2,063 | 5 | 3,950 | 1,412 | 208 | 2,330 | 0.272 |
| dark | 1,725 | 5 | 2,070 | 473 | 87 | 1,510 | 0.936 |
| total | 35,074 | 123 | 67,971 | 16,555 | 9,497 | 41,914 | 0.501 |

Faults applied is recipe applications; labelled rows counts marked elements (some recipes mark every match, such as
the focus-style recipes in controls and styles). Page-level recipes (`attribute: page`, mostly responsive) label the
view, not a row. Pixel verdicts are per labelled row: seen means at least 16 changed pixels and 1% of the box;
unseen rows are in the viewport with no visible change, the NOI candidates (focus styles that need the keyboard,
for example); 9,479 rows also carry `noisy` (more than 5% of the viewport changed outside the labelled boxes).

Recipe problems seen in the run (the recipes live in `research/visual/injectors.json`, not edited here):
`class-unbacked-token` threw 189 times (no numeric `bg-` shade class), `tw-config-tokens-missing` threw on SVG
elements (`className` is not a string there), `vh-hero-cta-bottom` threw on a null element, and
`shift-late-banner` never applied: it marks its element in a `setTimeout`, after the round's labels are read.

## Natural-bug prevalence (clean views, measured signals)

Shares of clean views with at least one element showing the signal. These are measurements, not verified bugs.

| signal | AI-builder desktop | AI-builder phone | control desktop | control phone |
|---|---:|---:|---:|---:|
| views | 3,000 | 2,986 | 599 | 594 |
| broken image (complete, not loaded, visible) | 1.7% | 1.6% | 6.3% | 5.9% |
| template leak pattern in visible text | 0.6% | 0.6% | 1.3% | 1.2% |
| text under 1.5:1 on a known solid background, loose | 19.0% | 18.6% | 24.5% | 23.6% |
| the same, strict (see below) | 9.0% | 8.8% | 15.7% | 14.8% |
| sideways scroll (document wider than the viewport) | 1.1% | 9.6% | 2.5% | 5.6% |
| no viewport meta | | 0.1% | | 2.9% |
| a declared font failed to load | 1.1% | 1.1% | 6.8% | 5.7% |

Light views. Phone dark (991 AI-builder, 193 control views) is in `summary.json`. The loose contrast signal also
counts hero text over a background image the ancestor chain cannot see and one-character separators; the strict
one needs at least 2 characters, a visible colour, ancestor opacity of at least 0.2, no background-clip text, and
agreement from the paint-stack read when the text is in the viewport. It still counts text outside the viewport that
the paint stack never checked, such as hidden carousel slides, so both are upper bounds. The most common leak pattern
on AI-builder pages was `placeholder-contact` (11 desktop pages).

By AI-builder domain, desktop light (phone sideways from the same host's phone view):

| domain | pages | broken image | leak | low contrast, strict | sideways on phone |
|---|---:|---:|---:|---:|---:|
| lovable.app | 1,434 | 12 | 12 | 130 | 145 |
| base44.app | 577 | 16 | 3 | 52 | 56 |
| replit.app | 375 | 4 | 0 | 27 | 23 |
| manus.space | 332 | 12 | 0 | 48 | 44 |
| vusercontent.net | 98 | 0 | 0 | 0 | 0 |
| created.app | 87 | 1 | 1 | 5 | 7 |
| emergent.host | 63 | 1 | 0 | 6 | 6 |
| genspark.space | 23 | 5 | 2 | 1 | 4 |
| windsurf.build | 11 | 0 | 1 | 0 | 1 |
| control (Tranco) | 599 | 38 | 8 | 94 | 33 |

## Training set

Near-duplicates: 3,434 layout clusters over 3,544 fingerprinted hosts; 110 hosts dropped from the matrices (the
largest cluster has 64 hosts, the next 6).

| split | hosts | views | natural rows | clean rows | fault rows | control rows |
|---|---:|---:|---:|---:|---:|---:|
| train | 2,804 | 27,931 | 2,435,257 | 796,232 | 54,288 | 1,815 |
| val | 351 | 3,550 | 282,352 | 101,978 | 7,233 | 238 |
| test | 305 | 3,126 | 262,293 | 88,468 | 5,994 | 212 |

## Sanity baseline

Not the shipped check: a check that element rows separate injected faults from clean elements. scikit-learn
HistGradientBoostingClassifier, fault against everything else, 108 of the 112 columns (pRound, pVw, pVh and pDark
dropped because they encode how a view was made), trained on 856,103 rows (all 54,288 faults, all controls, 400,000
clean and 400,000 natural rows sampled), 1,352 iterations, 45 s on c20. The threshold is the one that gives 0.9
precision on val, applied unchanged to test.

| measure | val | test |
|---|---:|---:|
| average precision (faults against clean and control rows) | 0.725 | 0.771 |
| ROC AUC | 0.957 | 0.968 |
| precision at the threshold | 0.900 | 0.905 |
| recall, all fault rows | 0.458 | 0.501 |
| recall, fault rows the pixel check saw | 0.749 | 0.757 |
| recall, fault rows unseen or outside the viewport | 0.365 | 0.425 |
| control rows flagged | 3.4% | 8.0% (17 of 212) |
| clean rows flagged | 0.35% | 0.34% |
| natural rows flagged (upper bound on false reports) | 0.19% | 0.15% |

Recall is lowest for design, other, controls and styles, the families whose labels sit on many elements or on
elements whose own computed style barely changes. Injected elements can also differ from natural ones in ways
that are not the bug (inline styles a recipe sets), so these numbers measure separability of the injected data,
not detection on real pages; the natural-row rate is the closer guide to false reports.
