# Clef as a judge of visibly broken elements: results (2026-10-14)

Method, prompt and worker: [`vision/clef/README.md`](../../clef/README.md). All numbers come from
`vision/clef/eval.py report` and are in `metrics.json` next to this file. No crop, image or host is in git.

- **Data.** 2,200 crops from the v2 contact sheets were labelled by a person (208 of them by two people, Cohen's
  kappa 0.705). The 344 unclear labels are left out, which leaves 1,856 crops: 1,717 not, 139 real. They were drawn by
  stratum from 83,402 candidate crops on val and test hosts: 800 crops a v1 rule flagged, 700 the v1 gbt-small model
  chose, and 700 random crops that no rule flagged.
- **Split by site.** Dev has 412 crops (25 real, 215 sites); every prompt, score and threshold choice was made there.
  Report has 1,444 crops (114 real, 767 sites); every number below is on report unless it says dev.
- **Models.** `@cf/cloudflare/clef` (27B, vision) and `@cf/cloudflare/clef-flash` (9B; its docs list vision too), on
  Workers AI through `genclass-clef-eval`.
- **Score.** `anyProblem` is 1 − P(family = none), chosen on dev. `notFine` is 1 − P(verdict = fine).
- **Intervals.** 95% intervals come from a host-level bootstrap (1,000 resamples; 2,000 for the paired differences).
- **Precision at recall r** is the best precision at any threshold where recall ≥ r. **Recall at precision p** is the
  best recall at any threshold where precision ≥ p.

## Headline (report, 1,444 crops, 114 real; prevalence 0.079)

| detector | AP [95% CI] | ROC AUC | P at R 0.5 [95% CI] | R at P 0.6 | R at P 0.8 | P at R 0.807 (the rules' recall) |
|---|---|---:|---|---:|---:|---:|
| v1 rules (measured thresholds), one operating point | – | – | – | – | – | **0.225** (408 flagged, 92 real) |
| v1 gbt-small model | 0.087 [0.061, 0.128] | 0.462 | 0.080 [0.065, 0.106] | 0.018 | 0.009 | 0.080 |
| **Clef, image + facts + caution (`clef-img-p3`, the dev choice)** | **0.576 [0.451, 0.690]** | 0.909 | **0.574 [0.423, 0.731]** | 0.412 | 0.254 | 0.390 |
| Clef, image + tag only (`clef-imgonly-p2`) | 0.668 [0.555, 0.763] | 0.922 | 0.769 [0.553, 0.885] | 0.632 | 0.395 | 0.382 |
| Clef, facts only, no image (`clef-text-p3`) | 0.267 [0.187, 0.374] | 0.804 | 0.286 [0.203, 0.389] | 0.026 | 0.026 | 0.149 |
| Clef-flash, image + facts (`flash-img-p3`) | 0.328 [0.222, 0.454] | 0.816 | 0.286 [0.189, 0.419] | 0.114 | 0.079 | 0.200 |
| Clef-flash, facts only (`flash-text-p3`) | 0.151 [0.105, 0.242] | 0.704 | 0.183 [0.139, 0.252] | 0.009 | 0.009 | 0.117 |

GenClass v2 visual model: no results were published at 2026-10-14T04:41Z (`origin/wave2/visual-v2` at 3a2ec3a has
no `vision/results/v2/TRAINING.md` or `RESULTS.md`), so it is not compared here. The search log on the training node
showed val `apReal` 0.137 to 0.190 over its first 7 trials. That is a different split and an unfinished search.

Precision along the curve (`anyProblem`):

| recall | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `clef-img-p3` | 0.938 | 0.806 | 0.729 | 0.648 | 0.574 | 0.523 | 0.449 | 0.390 | 0.242 |
| `clef-imgonly-p2` | 0.960 | 0.960 | 0.907 | 0.785 | 0.769 | 0.645 | 0.533 | 0.382 | 0.245 |
| `clef-text-p3` | 0.340 | 0.299 | 0.299 | 0.299 | 0.286 | 0.262 | 0.204 | 0.149 | 0.146 |
| v1 gbt-small | 0.080 | 0.080 | 0.080 | 0.080 | 0.080 | 0.080 | 0.080 | 0.080 | 0.080 |

The verdict question as the score (`notFine`) ranks worse: `clef-img-p3` AP 0.347 [0.242, 0.475], P at R 0.5 0.296,
R at P 0.8 0.096. `clef-imgonly-p2` AP 0.632 [0.510, 0.730], P at R 0.5 0.679, R at P 0.8 0.395.

Paired AP differences (report, host-level bootstrap):

| comparison | AP difference [95% CI] |
|---|---|
| image + tag only − image + facts (`clef-imgonly-p2` − `clef-img-p3`) | +0.092 [−0.007, 0.193] |
| image + facts − facts only (`clef-img-p3` − `clef-text-p3`): what the image adds | +0.309 [0.231, 0.376] |
| Clef-flash image + facts − facts only | +0.177 [0.104, 0.254] |
| Clef − Clef-flash, both image + facts | +0.248 [0.151, 0.339] |

On dev the order of the first pair was the other way round: image + facts 0.488, image + tag 0.413 (25 real).

## As a second stage on the rules' findings (the scanner's use)

The rules flag a candidate, and Clef keeps it when its score reaches the threshold that gave recall 0.5 on dev.
Recall is over every real on report (114).

| | flagged | real | precision | recall |
|---|---:|---:|---:|---:|
| v1 rules alone | 408 | 92 | 0.225 | 0.807 |
| rules, then `clef-img-p3` ≥ 0.9777 | 109 | 61 | 0.560 | 0.535 |
| rules, then `clef-imgonly-p2` ≥ 0.9376 | 107 | 69 | 0.645 | 0.605 |
| rules, then v1 gbt-small ≥ 0.0821 | 126 | 24 | 0.190 | 0.211 |

Within the 408 rule-flagged crops (base rate 0.225), `clef-img-p3` has AP 0.655, P at R 0.5 0.630, R at P 0.8 0.315.
`clef-imgonly-p2` has AP 0.768, P at R 0.5 0.836, R at P 0.8 0.576.

Per rule (report, rule-flagged crops; a crop with two rules counts under both):

| rule | flagged | real | kept by `clef-img-p3` (real) | kept by `clef-imgonly-p2` (real) |
|---|---:|---:|---:|---:|
| control-unreachable | 195 | 18 | 22 (9) | 41 (15) |
| page-overflow-x | 60 | 34 | 33 (21) | 26 (20) |
| css-var-undefined | 47 | 0 | 9 (0) | 0 (0) |
| text-invisible | 38 | 11 | 23 (11) | 11 (7) |
| image-distorted | 31 | 9 | 4 (4) | 10 (9) |
| image-broken | 17 | 15 | 13 (11) | 13 (13) |
| font-failed | 12 | 0 | 0 (0) | 0 (0) |
| text-template-leak | 6 | 5 | 6 (5) | 6 (5) |
| click-blocked | 4 | 0 | 0 (0) | 0 (0) |

The rules found none of the 22 reals in the gbt and random strata, because those strata hold only crops no rule
flagged. `clef-img-p3` ranks 4 of those 22 in its top 120, and `clef-imgonly-p2` ranks 10.

## Per family (families with at least 15 real on report)

Each family's reals are scored against every "not". "Own rules" means only the rules that look for that family. The
last two columns give Clef's precision at the own rules' recall.

| family (real) | own rules: P / R | Clef `anyProblem` AP / P at R 0.5 | Clef own-family probability AP / P at R 0.5 / R at P 0.8 | Clef P at the rules' recall (own prob / anyProblem) |
|---|---|---|---|---|
| overflow (35) | page-overflow-x: 0.519 / 0.800 | img-p3 0.270 / 0.265; imgonly 0.245 / 0.222 | img-p3 0.571 / 0.606 / 0.229; imgonly 0.385 / 0.250 / 0.143 | img-p3 0.406 / 0.115; imgonly 0.131 / 0.089 |
| media (27) | image-broken, image-distorted: 0.500 / 0.889 | img-p3 0.482 / 0.424; imgonly 0.834 / 0.944 | img-p3 0.951 / 0.955 / 1.000; imgonly 0.952 / 1.000 / 0.889 | img-p3 **0.900** / 0.205; imgonly 0.735 / 0.316 |
| dark (17) | text-invisible, css-var-undefined: 0.099 / 0.471 | img-p3 0.231 / 0.204; imgonly 0.261 / 0.310 | img-p3 0.025 / 0.034 / 0; imgonly 0.025 / 0.035 / 0 | img-p3 0.034 / 0.204; imgonly 0.035 / **0.310** |
| occlusion (16) | control-unreachable, click-blocked: 0.037 / 0.438 | img-p3 0.038 / 0.053; imgonly 0.083 / 0.081 | img-p3 0.213 / 0.068 / 0.062; imgonly 0.340 / 0.367 / 0 | img-p3 0.068 / 0.053; imgonly **0.367** / 0.081 |

Clef does not use the label "dark" for dark-scheme bugs. It files the 17 dark reals under `text` (img-p3: 8, imgonly:
15) or `occlusion` (img-p3: 8). Families under 15 real on report: text 6, leaks 7, responsive 6.

Family question, top choice on the 114 report reals: `clef-img-p3` 0.693, `clef-imgonly-p2` 0.675, `clef-text-p3`
0.623, `flash-img-p3` 0.553, `flash-text-p3` 0.439.

## By stratum (`anyProblem`, report)

| stratum (crops, real) | `clef-img-p3` AP / P at R 0.5 | `clef-imgonly-p2` AP / P at R 0.5 | `clef-text-p3` AP | v1 gbt-small AP |
|---|---|---|---:|---:|
| rule-flagged (408, 92) | 0.655 / 0.630 | 0.768 / 0.836 | 0.377 | 0.211 |
| gbt-chosen, no rule (523, 9) | 0.060 / 0.075 | 0.429 / 0.238 | 0.024 | 0.042 |
| random, no rule (513, 13) | 0.514 / 0.667 | 0.476 / 0.235 | 0.064 | 0.027 |

## Labelling "fine" from the low end (report)

| lowest-scored share of crops | crops | reals among them: `clef-img-p3` | `clef-imgonly-p2` | `clef-text-p3` |
|---|---:|---:|---:|---:|
| 50% | 722 | 5 (4.4% of reals) | 6 (5.3%) | 10 (8.8%) |
| 70% | 1,010 | 11 (9.6%) | 9 (7.9%) | 31 (27.2%) |
| 80% | 1,155 | 20 (17.5%) | 21 (18.4%) | 42 (36.8%) |

## Latency and cost

| variant | server ms median / p95 (loaded) | wall ms median / p95 (loaded) | server ms median / p95 (one at a time) | 40 at once, wall ms (5 bursts) | input tokens mean (p95) | USD per 1,000 elements | USD per 40-candidate scan |
|---|---|---|---|---|---:|---:|---:|
| `clef-img-p3` | 267 / 481 | 521 / 848 | 262 / 372 | 1,660 to 4,425 (median 1,972); slowest call in a burst 412 to 1,136 | 1,306 (1,478) | 0.313 | 0.0125 |
| `clef-imgonly-p2` | 233 / 413 | 520 / 908 | – | – | 999 (1,198) | 0.240 | 0.0096 |
| `clef-text-p3` | 212 / 343 | 510 / 760 | – | – | 1,123 (1,202) | 0.270 | 0.0108 |
| `flash-img-p3` | 712 / 2,099 | 944 / 2,432 | 613 / 1,673 | 4,916 to 8,929 (median 5,518) | 1,306 (1,478) | 0.050 | 0.0020 |
| `flash-text-p3` | 511 / 1,546 | 823 / 2,092 | – | – | 1,123 (1,202) | 0.043 | 0.0017 |

- **Server ms** is `env.AI.run` measured inside the worker. **Wall ms** is measured from the evaluation client over the
  public internet, so it includes TLS and the upload. "Loaded" means 6 to 8 calls in flight from each of two processes.
- **Pricing** is Workers AI, 2026-10-14: Clef $0.24 and Clef-flash $0.038 per million input tokens, no output charge.
  That is 21,818 and 3,455 neurons per million tokens. An image counts (w/32)·(h/32) + 3 tokens after resizing, at
  least about 64 and at most 1,024. A Clef call here is about 28 neurons, so the 10,000 free neurons a day cover about
  350 elements (about 9 scans).
- **This evaluation** made 12,164 calls (14.1 M input tokens), about $2.39 at list price, plus 2 × 300 latency calls.
