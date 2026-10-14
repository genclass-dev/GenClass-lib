# OpenAI Decisions as a judge of visibly broken elements, next to Clef: results (2026-10-14)

Can OpenAI's Decisions API (`POST /v1/decisions`, model `gpt-6-luna`) label GenClass's visual-bug crops as a
teacher, or work as a judge in the scanner, as well as Cloudflare's Clef? Both were run on the same crops, split,
prompts and scoring. Code: [`vision/openai_decisions/eval.py`](../../openai_decisions/eval.py). Every number is in
`metrics.json` next to this file. No crop, image, crop id, per-crop row or host is in git.

**Caveats.**
- **The Decisions API is a public beta.** `gpt-6-luna` is the only model it accepts. The answers, the token counting
  and the prices measured here (2026-10-14) may change.
- **The labels come from AI labellers, not people.** Six AI agents labelled the crops in parallel
  (`vision/results/v2/TRAINING.md` on `wave2/visual-v2`). On the 208 crops two of them labelled, Cohen's kappa is
  0.705. "Real" here means "real according to those labellers".

## Setup

- **Data and split.** These are the Clef evaluation's 1,856 crops (2,200 labelled, 344 unclear left out), and its
  `prepare` step reproduces that evaluation's `items.jsonl` record for record. Dev has 412 crops (25 real, 215 sites)
  and report has 1,444 (114 real, 767 sites), split by site.
- **Prompts.** The prompts are the Clef evaluation's two leaders, text for text: `luna-img-p3` is image + facts
  with the "judge by what the screenshot shows; facts are hints" caution, and `luna-imgonly-p2` is image + tag only.
  For all 1,856 crops, a check confirmed that the state text, both questions and every option description match
  `vision/clef/eval.py` (`wave2/clef-eval`, 3be5c2f) exactly.
- **Request.** Each call is one user message: an `input_text` part holding the state text, then an `input_image`
  part holding the JPEG crop as a base64 data URL. It carries two `choice` questions, `verdict` (8 options) and
  `family` (11 options).
- **Scores.**
  - `anyProblem` is 1 − P(family = none), the Clef evaluation's score.
  - `notFine` is 1 − P(verdict = fine); detectors that use it are named `…/notFine`.
  - Clef's numbers are recomputed with this script from its cached per-crop answers, and they match
    `vision/results/clef/RESULTS.md` exactly: AP, intervals, second stage and per family.
- **Ensembles** average the two judges' per-crop scores and family probabilities with equal weight. Nothing was
  fitted.
  - `ens-img-p3` is `luna-img-p3` + `clef-img-p3`, both `anyProblem`.
  - `ens-imgonly-p2` is `luna-imgonly-p2` + `clef-imgonly-p2`, both `anyProblem`.
  - `ens-devchoices` averages each judge's dev choice: `luna-img-p3/notFine` + `clef-img-p3`.
- **Metrics and intervals** follow the Clef evaluation: AP, precision at recall 0.5, recall at precision 0.6 and
  0.8, and the host-level bootstrap (1,000 resamples for intervals, 2,000 for paired differences). "Beats" or
  "loses" means the 95% interval of the paired difference excludes 0; "matches" means it contains 0.

**What was chosen on dev, before any report call.** These choices were recorded at 2026-10-14T16:31Z, when no report
crop had been sent. Each cell is dev AP, 25 real:

| | `anyProblem` | `notFine` |
|---|---:|---:|
| `luna-img-p3` | 0.441 | **0.697** |
| `luna-imgonly-p2` | 0.558 | 0.637 |
| `clef-img-p3` (Clef's dev choice) | 0.488 | 0.422 |
| `clef-imgonly-p2` | 0.413 | 0.307 |

`ens-devchoices` (Luna `notFine` averaged with Clef `anyProblem`) scored 0.704 on dev.

For Clef, the family question was the better score on dev, which is why the Clef evaluation uses it. For Luna it is
the verdict question, for both prompts. So Luna's dev choice is `luna-img-p3/notFine`. Both prompts were then run on report, and both
scores are reported. The like-for-like rows (same prompt, `anyProblem`) are the comparison that was
asked for; the dev-choice rows apply the Clef protocol (choose the score on dev) to Luna. Luna leans towards
"nothing wrong" more than Clef: on report "not" crops its mean P(family = none) is 0.65 where Clef's is 0.39, and
its top verdict is `fine` for 89% of them where Clef's is 58%. Why its family question ranks worse than its verdict
question is not established here.

## Headline (report, 1,444 crops, 114 real; prevalence 0.079)

| detector | AP [95% CI] | ROC AUC | P at R 0.5 [95% CI] | R at P 0.6 | R at P 0.8 | P at R 0.807 (the rules' recall) |
|---|---|---:|---|---:|---:|---:|
| v1 rules (measured thresholds), one operating point | – | – | – | – | – | 0.225 (408 flagged, 92 real) |
| **OpenAI `luna-img-p3/notFine` (its dev choice)** | **0.712 [0.617, 0.797]** | 0.946 | **0.826 [0.603, 0.929]** | 0.684 | **0.518** | 0.430 |
| OpenAI `luna-img-p3` (like for like with `clef-img-p3`) | 0.544 [0.431, 0.645] | 0.908 | 0.553 [0.411, 0.689] | 0.412 | 0.158 | 0.307 |
| OpenAI `luna-imgonly-p2` (like for like with `clef-imgonly-p2`) | 0.652 [0.549, 0.742] | 0.919 | 0.682 [0.536, 0.833] | 0.632 | 0.351 | 0.322 |
| OpenAI `luna-imgonly-p2/notFine` (not chosen) | 0.723 [0.624, 0.808] | 0.943 | 0.773 [0.634, 0.905] | 0.763 | 0.474 | 0.503 |
| Clef `clef-img-p3` (its dev choice) | 0.576 [0.451, 0.690] | 0.909 | 0.574 [0.423, 0.731] | 0.412 | 0.254 | 0.390 |
| Clef `clef-imgonly-p2` | 0.668 [0.555, 0.763] | 0.922 | 0.769 [0.553, 0.885] | 0.632 | 0.395 | 0.382 |
| **ensemble `ens-devchoices`** | **0.721 [0.626, 0.801]** | 0.940 | **0.845 [0.638, 0.950]** | 0.684 | 0.526 | 0.387 |
| ensemble `ens-img-p3` | 0.589 [0.479, 0.686] | 0.913 | 0.582 [0.433, 0.775] | 0.447 | 0.263 | 0.302 |
| ensemble `ens-imgonly-p2` | 0.726 [0.632, 0.805] | 0.943 | 0.765 [0.671, 0.893] | 0.702 | 0.456 | 0.487 |

Precision along the curve:

| recall | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `luna-img-p3/notFine` | 1.000 | 0.966 | 0.947 | 0.870 | 0.826 | 0.676 | 0.584 | 0.430 | 0.342 |
| `luna-imgonly-p2` | 1.000 | 0.939 | 0.854 | 0.742 | 0.682 | 0.621 | 0.526 | 0.322 | 0.217 |
| `clef-img-p3` | 0.938 | 0.806 | 0.729 | 0.648 | 0.574 | 0.523 | 0.449 | 0.390 | 0.242 |
| `clef-imgonly-p2` | 0.960 | 0.960 | 0.907 | 0.785 | 0.769 | 0.645 | 0.533 | 0.382 | 0.245 |
| `ens-devchoices` | 1.000 | 1.000 | 0.951 | 0.906 | 0.845 | 0.683 | 0.541 | 0.387 | 0.319 |

Paired AP differences (report, host-level bootstrap, 2,000 resamples):

| comparison | AP difference [95% CI] | |
|---|---|---|
| `luna-img-p3` − `clef-img-p3` (same prompt, same score) | −0.032 [−0.141, 0.079] | matches |
| `luna-imgonly-p2` − `clef-imgonly-p2` (same prompt, same score) | −0.015 [−0.124, 0.094] | matches |
| `luna-img-p3/notFine` − `clef-img-p3` (dev choice against dev choice) | **+0.136 [0.035, 0.236]** | beats |
| `luna-img-p3/notFine` − `clef-imgonly-p2` (against Clef's report leader) | +0.045 [−0.046, 0.132] | matches |
| `luna-img-p3/notFine` − `luna-img-p3` (what the verdict score adds) | +0.168 [0.103, 0.239] | |
| `luna-imgonly-p2` − `luna-img-p3` (no facts against facts, `anyProblem`) | +0.109 [0.024, 0.198] | |
| `ens-devchoices` − `luna-img-p3/notFine` (what Clef adds to Luna) | +0.009 [−0.012, 0.029] | matches |
| `ens-devchoices` − `clef-img-p3` | +0.145 [0.052, 0.237] | beats |
| `ens-devchoices` − `clef-imgonly-p2` | +0.054 [−0.033, 0.136] | matches |
| `ens-img-p3` − `luna-img-p3` / − `clef-img-p3` | +0.046 [0.016, 0.074] / +0.013 [−0.087, 0.115] | |
| `ens-imgonly-p2` − `luna-imgonly-p2` / − `clef-imgonly-p2` | +0.074 [0.043, 0.106] / +0.059 [−0.030, 0.152] | |

With the same prompt and the same score, Luna and Clef are indistinguishable. Luna's verdict question is the best
single score measured. Averaging in Clef helps Luna under `anyProblem` but adds nothing to Luna's dev choice.

## As a second stage on the rules' findings (the scanner's use)

The rules flag a candidate, and the judge keeps it when its score reaches the threshold that gave recall 0.5 on dev.
Recall is over every real on report (114).

| | flagged | real | precision | recall | AP within the 408 rule-flagged |
|---|---:|---:|---:|---:|---:|
| v1 rules alone | 408 | 92 | 0.225 | 0.807 | – |
| rules, then `luna-img-p3/notFine` ≥ 0.90 | 46 | 41 | **0.891** | 0.360 | 0.745 |
| rules, then `luna-img-p3` ≥ 0.84 | 121 | 59 | 0.488 | 0.518 | 0.578 |
| rules, then `luna-imgonly-p2` ≥ 0.81 | 73 | 51 | 0.699 | 0.447 | 0.724 |
| rules, then `clef-img-p3` ≥ 0.9777 | 109 | 61 | 0.560 | 0.535 | 0.655 |
| rules, then `clef-imgonly-p2` ≥ 0.9376 | 107 | 69 | 0.645 | 0.605 | 0.768 |
| rules, then `ens-devchoices` ≥ 0.9398 | 45 | 40 | 0.889 | 0.351 | 0.764 |
| rules, then `ens-imgonly-p2` ≥ 0.8747 | 70 | 55 | 0.786 | 0.482 | 0.786 |

Luna answers in steps of 0.01, so its scores take at most 101 values on report, against about 1,280 for Clef. With
25 dev reals, its dev threshold lands at a stricter point on report: over all report crops it gives recall 0.41,
not 0.5. Inside the rule flags it ranks as well as Clef (AP 0.745 against 0.655 and 0.768), so most of the
difference in this table is the operating point.

Per rule (report, rule-flagged crops; a crop with two rules counts under both). Each cell is kept (of them real):

| rule | flagged | real | `luna-img-p3/notFine` | `luna-imgonly-p2` | `clef-img-p3` | `clef-imgonly-p2` | `ens-devchoices` |
|---|---:|---:|---:|---:|---:|---:|---:|
| control-unreachable | 195 | 18 | 6 (4) | 23 (10) | 22 (9) | 41 (15) | 5 (3) |
| page-overflow-x | 60 | 34 | 11 (10) | 25 (17) | 33 (21) | 26 (20) | 11 (10) |
| css-var-undefined | 47 | 0 | 1 (0) | 0 (0) | 9 (0) | 0 (0) | 1 (0) |
| text-invisible | 38 | 11 | 4 (3) | 1 (1) | 23 (11) | 11 (7) | 4 (3) |
| image-distorted | 31 | 9 | 6 (6) | 9 (8) | 4 (4) | 10 (9) | 6 (6) |
| image-broken | 17 | 15 | 13 (13) | 15 (15) | 13 (11) | 13 (13) | 13 (13) |
| font-failed | 12 | 0 | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |
| text-template-leak | 6 | 5 | 6 (5) | 0 (0) | 6 (5) | 6 (5) | 6 (5) |
| click-blocked | 4 | 0 | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |

Like Clef, Luna should not filter `page-overflow-x`: at its dev threshold it keeps 10 of the 34 overflow reals.
Image + tag only also drops every `text-template-leak` real.

## Per family (families with at least 15 real on report)

Each family's reals are scored against every "not". "Score" is the detector's own score (`notFine` for the Luna dev
choice, `anyProblem` for the others). "Own prob." is that family's probability on the family question. "At the
rules' recall" is precision at the recall of the rules that look for that family, given first for the family
probability and then for the score.

| family (real) | own rules P / R | detector | score AP / P at R 0.5 | own prob. AP / P at R 0.5 / R at P 0.8 | P at the rules' recall (own prob. / score) |
|---|---|---|---|---|---|
| overflow (35) | page-overflow-x 0.519 / 0.800 | `luna-img-p3/notFine` | 0.381 / 0.292 | 0.551 / 0.523 / 0.029 | 0.431 / 0.174 |
| | | `luna-imgonly-p2` | 0.386 / 0.323 | 0.434 / 0.373 / 0.114 | 0.292 / 0.231 |
| | | `clef-img-p3` | 0.270 / 0.265 | 0.571 / 0.606 / 0.229 | 0.406 / 0.115 |
| | | `clef-imgonly-p2` | 0.245 / 0.222 | 0.385 / 0.250 / 0.143 | 0.131 / 0.089 |
| | | `ens-devchoices` | 0.422 / 0.345 | **0.700 / 0.857 / 0.514** | **0.622** / 0.185 |
| media (27) | image rules 0.500 / 0.889 | `luna-img-p3/notFine` | 0.850 / 0.941 | 0.924 / 0.933 / 0.889 | 0.743 / 0.463 |
| | | `luna-imgonly-p2` | 0.880 / 1.000 | 0.935 / 1.000 / 0.926 | 0.862 / 0.676 |
| | | `clef-img-p3` | 0.482 / 0.424 | 0.951 / 0.955 / 1.000 | **0.900** / 0.205 |
| | | `clef-imgonly-p2` | 0.834 / 0.944 | 0.952 / 1.000 / 0.889 | 0.735 / 0.316 |
| | | `ens-devchoices` | 0.874 / 1.000 | **0.966 / 1.000 / 1.000** | 0.867 / 0.510 |
| dark (17) | text-invisible, css-var-undefined 0.099 / 0.471 | `luna-img-p3/notFine` | 0.168 / 0.148 | 0.084 / 0.026 / 0 | 0.026 / 0.148 |
| | | `luna-imgonly-p2` | 0.065 / 0.036 | 0.023 / 0.018 / 0 | 0.018 / 0.036 |
| | | `clef-img-p3` | 0.231 / 0.204 | 0.025 / 0.034 / 0 | 0.034 / 0.204 |
| | | `clef-imgonly-p2` | 0.261 / 0.310 | 0.025 / 0.035 / 0 | 0.035 / **0.310** |
| | | `ens-devchoices` | 0.194 / 0.180 | 0.032 / 0.034 / 0 | 0.034 / 0.180 |
| occlusion (16) | control-unreachable, click-blocked 0.037 / 0.438 | `luna-img-p3/notFine` | 0.135 / 0.105 | 0.408 / 0.360 / 0.188 | 0.360 / 0.105 |
| | | `luna-imgonly-p2` | 0.173 / 0.220 | 0.334 / 0.571 / 0 | **0.571** / 0.220 |
| | | `clef-img-p3` | 0.038 / 0.053 | 0.213 / 0.068 / 0.062 | 0.068 / 0.053 |
| | | `clef-imgonly-p2` | 0.083 / 0.081 | 0.340 / 0.367 / 0 | 0.367 / 0.081 |
| | | `ens-devchoices` | 0.107 / 0.060 | 0.337 / 0.444 / 0.062 | 0.444 / 0.060 |

Beats, matches or loses to Clef, per family. Each cell is the paired AP difference, OpenAI minus Clef, with its 95%
interval (host-level bootstrap, 2,000 resamples). The first value is on the score, the second on the family's own
probability:

| family (real) | `luna-img-p3` − `clef-img-p3` | `luna-imgonly-p2` − `clef-imgonly-p2` | `luna-img-p3/notFine` − `clef-img-p3` | `luna-img-p3/notFine` − `clef-imgonly-p2` |
|---|---|---|---|---|
| overflow (35) | score −0.100 [−0.226, 0.001] matches; own −0.020 [−0.202, 0.150] matches | +0.141 [−0.028, 0.288] matches; +0.048 [−0.115, 0.214] matches | +0.110 [−0.050, 0.270] matches; own as left | +0.136 [−0.035, 0.289] matches; +0.165 [−0.020, 0.354] matches |
| media (27) | **+0.220 [0.048, 0.396] beats**; −0.028 [−0.156, 0.076] matches | +0.045 [−0.112, 0.270] matches; −0.017 [−0.056, 0.019] matches | **+0.368 [0.163, 0.562] beats**; own as left | +0.016 [−0.164, 0.228] matches; −0.028 [−0.166, 0.061] matches |
| dark (17) | −0.132 [−0.422, 0.021] matches; +0.059 [0.001, 0.287] beats (both under 0.09) | −0.195 [−0.491, 0.037] matches; −0.002 [−0.015, 0.040] matches | −0.063 [−0.270, 0.064] matches; own as left | −0.093 [−0.373, 0.128] matches; +0.059 [−0.005, 0.301] matches |
| occlusion (16) | +0.039 [−0.016, 0.122] matches; +0.194 [−0.069, 0.457] matches | +0.089 [−0.019, 0.241] matches; −0.006 [−0.236, 0.187] matches | **+0.097 [0.008, 0.284] beats**; own as left | +0.051 [−0.038, 0.207] matches; +0.068 [−0.252, 0.314] matches |

No family loses. On media, Luna's overall score is much better than Clef's facts-prompt score. For "which family",
the averaged family probabilities are the strongest:
- On overflow, `ens-devchoices` reaches own-probability AP 0.700, against 0.551 for Luna alone (+0.149 [0.033,
  0.280]) and 0.385 for Clef's image + tag (+0.314 [0.154, 0.493]).
- On media it reaches 0.966 (+0.042 [0.005, 0.117] over Luna).
- Neither judge uses `dark` for dark-scheme bugs. Luna files the 17 dark reals under `text` (8), `occlusion`,
  `overflow` and `none` (3 each). Family top-1 accuracy on the 114 reals is 0.640 for Luna, 0.693 for Clef and 0.728
  for the average.

Families under 15 real on report: text 6, leaks 7, responsive 6.

## By stratum, and the low end (report)

| stratum (crops, real) | `luna-img-p3/notFine` AP / P at R 0.5 | `luna-imgonly-p2` | `clef-img-p3` | `clef-imgonly-p2` | `ens-devchoices` |
|---|---|---|---|---|---|
| rule-flagged (408, 92) | 0.745 / 0.839 | 0.724 / 0.727 | 0.655 / 0.630 | 0.768 / 0.836 | 0.764 / 0.839 |
| gbt-chosen, no rule (523, 9) | 0.483 / 0.455 | 0.410 / 0.467 | 0.060 / 0.075 | 0.429 / 0.238 | 0.390 / 0.231 |
| random, no rule (513, 13) | 0.640 / 0.800 | 0.613 / 0.778 | 0.514 / 0.667 | 0.476 / 0.235 | 0.600 / 0.875 |

| lowest-scored share of crops | crops | reals among them: `luna-img-p3/notFine` | `luna-imgonly-p2` | `clef-img-p3` | `clef-imgonly-p2` | `ens-devchoices` |
|---|---:|---:|---:|---:|---:|---:|
| 50% | 722 | **0** | 3 | 5 | 6 | 3 |
| 70% | 1,010 | 7 (6.1%) | 15 | 11 | 9 | 7 |
| 80% | 1,155 | 13 (11.4%) | 21 | 20 | 21 | 14 |

## Tokens, latency and cost

| | `luna-img-p3` | `luna-imgonly-p2` | Clef `clef-img-p3` | Clef `clef-imgonly-p2` |
|---|---:|---:|---:|---:|
| input tokens per call, mean (p95) | 1,099 (1,335) | 826 (1,100) | 1,306 (1,478) | 999 (1,198) |
| of which image, mean / median | 76 / 25 | 76 / 25 | – | – |
| USD per 1,000 elements, standard | **0.110** | 0.083 | 0.313 | 0.240 |
| USD per 1,000 elements, Batch/Flex | **0.055** | 0.041 | – | – |
| USD per 40-candidate scan, standard | 0.0044 | 0.0033 | 0.0125 | 0.0096 |
| server ms median / p95, one call at a time | 101 / 282 | – | 262 / 372 | – |
| wall ms median / p95, one call at a time | 329 / 551 | 365 / 668 (pilot) | – | – |
| server ms median / p95, all scored calls (8 in flight after the pilot) | 120 / 428 | 106 / 328 | 267 / 481 | 233 / 413 |
| wall ms median / p95, all scored calls | 388 / 797 | 363 / 737 | 521 / 848 | 520 / 908 |
| 40 sent at once, wall ms (5 bursts) | 1,388 to 3,918 (median 1,866) | – | 1,660 to 4,425 (median 1,972) | – |

- **Pilot (step 1).** The first 100 dev crops were sent one at a time. `luna-img-p3` averaged 1,090 input tokens a
  call (p95 1,338). The same text without the image averaged 1,028, so the image is 62 tokens on average (median 16,
  p95 352).
  - For all 100 crops the image cost exactly ⌈w/32⌉ · ⌈h/32⌉ + 1 tokens, with no downscaling up to 1,366 × 768. That
    formula gives the image tokens above for all 1,856 crops.
  - Text is about 93% of a call. The two questions with their option descriptions are most of it: image + tag only
    still sends about 750 text tokens.
  - Usage reports `input_tokens`, `input_tokens_details` (cached and cache-write tokens, both 0 here),
    `output_tokens` (0) and `total_tokens`. It does not split image from text.
- **Server ms** is the `openai-processing-ms` response header. **Wall ms** is measured from the evaluation client, a
  Mac, over the public internet. Clef's server time is `env.AI.run` inside its Worker.
- **Pricing** is $0.10 per million input tokens and $0.05 with Batch/Flex, no output charge (2026-10-14). Batch was
  not used here; its figure is the list price applied to the measured tokens. Clef is $0.24 per million on Workers
  AI, and it counts more tokens per call. So Luna costs about a third as much per element.
- **Spend for this evaluation:** 4,112 calls and 4,003,864 input tokens, **$0.40** at the standard price, against a
  $15 cap. The total covers 3,712 scored calls, 100 text-only calls for the token split and 300 latency calls. No
  call failed and no answer was a refusal.

## Recommendation: use it as the teacher; ensemble only for the family label

1. **Teacher for the in-browser model: yes.** Use `gpt-6-luna` with the image + facts + caution prompt and score
   `1 − P(verdict = fine)`.
   - It is the strongest single judge measured on these crops: AP 0.712, precision 0.83 at recall 0.5, recall 0.52
     at precision 0.8.
   - The lowest-scored half of the report crops holds none of the 114 reals, against 5 to 6 for Clef. So that half
     is a safe source of "fine" labels.
   - It costs $0.11 per 1,000 elements, or $0.055 with Batch.
   - Have a person check positives below precision 0.8. The family label works for media; for overflow, use the
     averaged family probabilities.
   - As with Clef, nothing in this setup labels dark-scheme bugs.
2. **Ensemble with Clef: only for "which family".** Averaging the two scores adds nothing measurable to Luna's dev
   choice (+0.009 [−0.012, 0.029]) and costs about four times as much as Luna alone ($0.42 against $0.11 per
   1,000 elements). Averaging the family probabilities raises overflow own-family AP from 0.551 to 0.700 and family
   top-1 on reals from 0.640 to 0.728. That reading comes from report numbers, so confirm it on a fresh labelled
   batch before relying on it.
3. **Scanner second stage.** Luna is faster and cheaper than Clef. At its dev threshold it is far more precise
   (0.89 against 0.56 to 0.65) but keeps fewer reals (41 of 92 rule-found, against 61 to 69).
   - Choose its threshold on more labelled data. With 101 score levels and 25 dev reals, the threshold is coarse.
   - As with Clef, leave `page-overflow-x`, `image-broken` and `text-template-leak` findings unfiltered.
   - Inside the rule flags the two rank alike (AP 0.745 against 0.655 and 0.768), so the scanner has no accuracy
     reason to switch. It runs on Cloudflare already, and using Luna would send screenshots of scanned pages to a
     second vendor; that is a disclosure decision for the owner.
4. **Against Clef, with the same prompt and score:** a match overall. Per family, on the score, it matches everywhere except media
   with the facts prompt, where it beats Clef (+0.220 [0.048, 0.396]); it loses nowhere. **With each judge's own dev
   choice:** Luna beats Clef's dev choice (+0.136 [0.035, 0.236]; per family it beats on media and occlusion) and
   matches Clef's report leader, image + tag only (+0.045 [−0.046, 0.132]).

## Run

```
python3 eval.py prepare --data DATA --work WORK          # DATA is the Clef evaluation's data dir
python3 eval.py run --work WORK --variant luna-img-p3 --split dev --limit 100 --concurrency 1   # the pilot
python3 eval.py run --work WORK --variant luna-imgonly-p2 --split dev --limit 100 --concurrency 1
python3 eval.py tokens --work WORK --split dev --limit 100 --concurrency 1   # same text, no image
python3 eval.py run --work WORK --variant luna-img-p3 --split dev            # then luna-imgonly-p2; then --split report
python3 eval.py latency --work WORK --variant luna-img-p3
python3 eval.py report --work WORK --clef-work CLEF_WORK --dev-choice luna-img-p3/notFine --out metrics.json
python3 eval.py show --work WORK --variant luna-img-p3 --id <crop id>   # the exact request, image omitted
python3 eval.py spend --work WORK
```

The key is read from `~/.jev-local/secrets/openai.key` (or `--key-file`) inside the process, sent only in the
`Authorization` header to `https://api.openai.com`, and never printed or written. API error text is redacted before
it is printed. Spend is summed from each response's `usage.input_tokens` into `WORK/spend.json`. No call starts if
the spend so far, plus every call in flight at the largest size seen, would pass `--cap-usd` (default 14.5). Answers
are cached one file per crop under `WORK/runs/`, so a run resumes where it stopped. Python 3.9+ and numpy.
