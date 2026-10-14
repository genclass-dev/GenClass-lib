# GenClass Vision v2: results (2026-10-14)

Vision v2 is Vision v1's small image model retrained with a new teacher: OpenAI's Decisions API. Vision v1 was
taught by Cloudflare's Clef. Code: [`vision/vision_v2`](../../vision_v2/README.md). Every file next to this one holds
aggregates only. No crop, screenshot, crop id, per-crop row or host is in git.

**Caveats.**
- **Every label here comes from AI labellers (Claude subagents), not from people.** That covers the 600 fresh dev
  crops (two blind passes and an adjudication pass) and Vision v1's 1,300 frozen test crops.
- **The teacher is a public-beta API.** It is `gpt-6-luna` on `POST /v1/decisions`, the only model that endpoint
  accepts. Its answers, token counting and prices (measured 2026-10-14) may change.
- **This is the frozen test set's second use.** Vision v1 used it first. Nothing in Vision v2 was tuned on it: the
  model, its score and every threshold were fixed on the fresh dev set first, and `evaluate.py final` ran once.

## Answer first

- **No Vision v2 family ships.** At the thresholds chosen on the fresh dev set, no Vision v2 family detector reaches
  60% in-family precision with at least 10 flags on the test set:
  - media: 106 flags, 15 real (14%);
  - responsive: 40 flags, 7 real (18%);
  - text: 14 flags, 7 real (50%; weighted 48%);
  - the media rules filtered by Vision v2: 27 flags, 5 real (19%).
  - Dev gave no threshold for overflow, occlusion, dark, leaks, blank, controls or other.
  Every family stays on the measured checks.
- **Overall ranking: far better than Vision v1, level with Clef, a little under OpenAI.**
  - Any-problem AP 0.611 against Vision v1's 0.518, on the same 1,052 test crops (173 real). The paired difference is
    +0.093 [0.013, 0.170], so it **beats** Vision v1.
  - Precision at recall 0.5 is 0.635 (v1: 0.479). Recall at precision 0.6 is 0.538 (v1: 0.318).
  - It **matches** Clef (0.615; −0.004 [−0.099, 0.085]).
  - It **matches** its teacher OpenAI (0.651; −0.040 [−0.119, 0.044]).
  - It **matches** OpenAI and Clef averaged (0.686; −0.075 [−0.151, 0.003]).
- **Per family (own-family AP on test).**
  - Against Clef: it **falls short** on text (0.304 against 0.511) and **matches** on overflow, occlusion and media.
  - Against OpenAI: it **beats** OpenAI on occlusion (+0.064 [0.003, 0.185]) and matches it elsewhere.
  - Against Vision v1: it matches on all four families.
  - Overflow is its best family: AP 0.691 and precision 0.85 at recall 0.5. Vision v1 got 0.589 and Clef 0.569.
- **Behind the rules (the scanner's use).** The measured rules flag 500 test crops, 15% of them real. Vision v2 keeps
  69 of those, 48% real. Vision v1 keeps 72 (36% real), Clef 50 (56%), OpenAI 86 (41%) and OpenAI with Clef 74 (47%).
- **Why nothing ships: the thresholds did not transfer, as for Vision v1.**
  - Media is the clearest case.
    - The dev labellers called 38 of 600 dev crops media bugs (6.3%). The test labellers called 16 of 1,300 (1.2%).
    - Among crops where Clef gives P(media) ≥ 0.5, 35 of 36 are media bugs on dev but 15 of 33 on test (8 unclear).
    - So the dev threshold (P(media) ≥ 0.10) sits far too low for the test labels.
    - Media ranking itself is good: Vision v2 media AP 0.759, precision 0.89 at recall 0.5.
  - Either the dev crops' media defects are plainer or the two labeller pools judge media differently. This set
    cannot tell which.
- **A lead, not a result.** Clef's own text detector, at its fresh-dev threshold, passes the ship rule on test: 17
  flags, 14 real text bugs, 0.82 [0.59, 0.94], weighted 0.83. It is one of about 40 operating points evaluated, and the
  Clef evaluation never chose it. Confirm it on fresh labels before using it.
- **Small and fast: same network as Vision v1.**
  - Model: 1.19 M parameters, 4.77 MB as ONNX fp32.
  - Latency: 0.53 ms per crop on one CPU thread (AMD EPYC 9V45, onnxruntime 1.31, batch 1).
  - Clean environment (`env -i`, `python -I`, a fresh venv with only numpy, Pillow and onnxruntime), scored from raw
    crops and raw element rows:
    - 6.6 ms per crop, Python start-up included;
    - matches PyTorch to 2.8e-6, rank correlation 1.0.
- **Cost.**
  - OpenAI: **US$10.98** for 100,027 calls (109.8 M input tokens at the standard $0.10 per million), against the $25
    cap.
  - VM: about **1.1 hours** of one F80 node (c20, 16:47 to 17:53 UTC). All eight training runs ran at once, 28 to 30
    minutes each.

## What was built

### Teacher labels (OpenAI, from the Mac)

- **Crops.** The teacher labelled Vision v1's 100,000 natural crops of round-2 train hosts:
  - 64,822 full-resolution crawl candidate crops;
  - 35,178 crops cut from the stored viewport shots.
- **Request.** It is `luna-img-p3`, the variant `wave2/openai-decisions` chose on dev: image, measured facts and the
  "judge by what the screenshot shows" caution, with two choice questions (verdict, 8 options; family, 11 options).
  - The state text is Clef's `clef-img-p3` state, checked character for character on 3,000 crops.
  - The score is notFine = 1 − P(verdict = fine).
- **The key stayed on the Mac.**
  - The data node built the request bodies under random tokens (`secrets.token_hex`). The token-to-crop key never
    left the node.
  - The Mac pulled each batch of 2,000 over ssh and sent the calls, with the key only in the `Authorization` header.
    It pushed the probability vectors back to the node and deleted the batch's requests (they hold the crops) as
    soon as the answers were on the node.
- **No Batch API.** Its endpoint list does not include `/v1/decisions` (2026-10-14), and Flex is documented only for
  Responses and Chat Completions. So these were standard calls with backoff.
  - Two processes of 24 threads each, against limits of 10,000 requests and 10 M tokens a minute.
  - A kept-alive HTTPS connection per thread raised the rate from about 30 to 80 calls a second per process. A new
    TLS connection per call had been most of the wall time; server time was about 100 ms.
- **Coverage.** 99,991 crops got both probability vectors. The other 9 answers had no probabilities; those crops are
  left out of training. None of them is a dev or test crop.
- **Tokens.** 1,098 input tokens per call on average (p95 1,337).
- **The averaged family label.** For every crop it is the mean of OpenAI's family answer and Clef's. Clef's is the
  mean of its two prompts, from Vision v1's cached answers, which cover all 100,000 crops.

### The fresh dev set (`devset.py`, built the way the test set was)

- **Hosts.** The candidates are round-2 train hosts that are not near-duplicates and have no labelled crop of any
  kind (348 hosts excluded). The 815 hosts Vision v1 held out for its test set are excluded too, which leaves 4,442.
  - 8.2% of them by a salted hash (salt `vision-v2-fresh-dev`) are the dev hosts: 404.
  - Vision v2 trains on no element of them (7,108 natural crops left out).
  - Vision v1 did train on these hosts (with Clef's labels), so its dev numbers flatter it. It keeps the thresholds
    it chose on round-2 dev labels.
- **Pool.** The crawl's full-resolution candidate crops on 398 of the dev hosts: 4,527 crops (263 rule-flagged,
  2,093 random visible elements).
- **Strata.** The test's design, drawn in the same order with the same Clef teacher score: rules 230, random 162,
  clef-high 162, clef-low 46 (the test's 500 : 350 : 350 : 100, scaled to 600).
  - 600 crops of 235 hosts.
  - Desktop 301, phone 299; light 439, dark 161; AI-builder 431, control 169.
  - Each crop records its inclusion probability. Dev and sheet ids are random.
- **Labels.** The labellers used the test set's `LABELLING.md`, with three edits: a new title, one added sentence, and
  "no Clef answer" widened to "no model answer". The families, the question and the output format are unchanged.
  - Pass A and pass B were three agents each, one per block of about 22 sheets. No agent labelled in two passes.
  - Pass C was one more agent, on new sheets for the 72 crops where A and B differed.
  - The labellers saw only their own sheets: no model score, no Clef or OpenAI answer, no rule flag, no stratum. The
    sheets left the Mac after each pass.
  - A and B agreed on the verdict for 88.2% of crops (kappa 0.788; the test's passes reached 0.711), and on the
    family for 99.0% when both said real.
  - Resolved by the test's rule: 105 real, 124 unclear, 371 not.
  - Real by family: media 38, text 16, occlusion 16, overflow 10, dark 7, leaks 6, blank 5, responsive 4, mixed 2,
    other 1.
  - Real by stratum: clef-high 72 of 162, rules 30 of 230, random 3 of 162, clef-low 0 of 46.
- **Digests.**
  - Manifest: `45549129cc94ffb28b3fbe13acd1559d735808353b5372dc99333f4ea8f6cff3`.
  - Labels (`devset.py labeldigest`): `61d3da2ba39a898d43a49fdb28327e81d62497855b2d9a39a25e93d623264b04`.
- **Against the test set,** the dev set is richer in real bugs: 17.5% against 13.3%, and 44% against 24% in the
  clef-high stratum. The difference is mostly media.

### Student (`train.py`)

- **Recipe.** Vision v1's chosen run (f-s-lr5):
  - MobileNetV3-small with ImageNet weights, over a 224 x 128 letterboxed crop;
  - the 64 measured facts through a small MLP, joined before a 384-unit trunk;
  - AdamW with a cosine schedule, 12 epochs, bf16;
  - the degraded-copy swap at p 0.5 and an 8 px shift; no injected faults.
- **Heads.**
  - The verdict head (8 classes) is taught by OpenAI's verdict answer. The score is notFine = 1 − P(fine).
  - The family head (11 classes) is taught by OpenAI's family answer ("L" runs) or by the OpenAI and Clef average
    ("A" runs).
  - The "AH" runs add an any-problem head, taught by the mean of OpenAI's notFine and Clef's anyProblem.
- **Training crops.** 74,362: the 100,000 natural crops, minus the 14,228 on the test's held-out hosts, minus the
  7,108 on the dev hosts, minus 4,293 on 5% of hosts kept back to measure agreement with the teacher.
  - On those held-back hosts, the chosen model's notFine correlates 0.837 with OpenAI's.
- **Runs.** All eight ran at once on c20, one per 10 vCPUs with 9 threads, at about 510 crops a second each.

### Model choice (fresh dev; unclear left out: 476 crops, 105 real)

Each run is scored by its dev AP averaged over its last three epochs. The planned any-problem scores are notFine for
every run and the any head where there is one; anyF = 1 − P(family = none) is shown for comparison. The best run is
the model, and its final checkpoint is used.

| run | family target | any head | lr head / backbone | seed | score | dev AP (last 3) | dev AP final | round-2 dev AP |
|---|---|---|---|---:|---|---:|---:|---:|
| **A5s2 (chosen)** | OpenAI + Clef | no | 5e-3 / 2e-3 | 2 | notFine | **0.767** | 0.766 | 0.656 |
| A5 | OpenAI + Clef | no | 5e-3 / 2e-3 | 1 | notFine | 0.756 | 0.762 | 0.654 |
| L5s2 | OpenAI | no | 5e-3 / 2e-3 | 2 | notFine | 0.755 | 0.756 | 0.613 |
| AH5 | OpenAI + Clef | yes | 5e-3 / 2e-3 | 1 | any head | 0.752 | 0.750 | 0.664 |
| AH5 | OpenAI + Clef | yes | 5e-3 / 2e-3 | 1 | notFine | 0.745 | 0.742 | 0.654 |
| A3 | OpenAI + Clef | no | 3e-3 / 1.2e-3 | 1 | notFine | 0.740 | 0.739 | 0.633 |
| L5 | OpenAI | no | 5e-3 / 2e-3 | 1 | notFine | 0.729 | 0.733 | 0.648 |
| A5s2 | OpenAI + Clef | no | 5e-3 / 2e-3 | 2 | anyF | 0.729 | 0.727 | 0.617 |
| AH3 | OpenAI + Clef | yes | 3e-3 / 1.2e-3 | 1 | any head | 0.719 | 0.718 | 0.640 |
| L3 | OpenAI | no | 3e-3 / 1.2e-3 | 1 | notFine | 0.716 | 0.712 | 0.625 |
| AH3 | OpenAI + Clef | yes | 3e-3 / 1.2e-3 | 1 | notFine | 0.701 | 0.702 | 0.643 |

All 18 run-score pairs are in `selection.json`. Round-2 dev AP is on Vision v1's dev crops (1,856 round-2 crops, 139
real), where Vision v1 scored 0.651.

- **OpenAI + Clef against OpenAI only.** The averaged family target scores slightly higher with the same settings
  (0.754 against 0.733, mean of three pairs). The two seeds of one configuration differ by 0.011 to 0.026, so this is
  within noise.
- **notFine against anyF.** notFine beats anyF in every run, by 0.04 to 0.07, as it did for OpenAI itself.
- **The any head.** It scores slightly above its own run's notFine (+0.007 and +0.018). Both AH runs still rank below
  the best plain runs, and the gaps are within noise.

On the fresh dev set the chosen model scores AP 0.764 in fp32 evaluation (0.766 under the bf16 scoring used during
training). OpenAI scores 0.821, Clef 0.824 and the two averaged 0.847. Vision v1 scores 0.819, but it trained on these
hosts.

### Thresholds (fresh dev only, `dev.json`)

For every detector and family f, the threshold is the lowest one at which at least 60% of the dev flags are in-family
real bugs (unclear counted as not real), with at least 5 dev flags. Vision v1's TEST-FROZEN.md uses this rule.

- **Vision v2 got thresholds for:**
  - any problem (0.715);
  - media (P(media) ≥ 0.101);
  - text (0.698);
  - responsive (0.199);
  - the media rules filtered by Vision v2 (0.149).
- **The second-stage threshold** is the dev threshold for recall 0.5: notFine ≥ 0.752.
- Overflow (10 dev reals), occlusion (16), dark, leaks and blank got no threshold.
- OpenAI, Clef and their average got their thresholds the same way, on the same dev crops. Vision v1 keeps its own.

## The frozen test set, second use

- **The set** is Vision v1's [`TEST-FROZEN.md`](../vision-v1/TEST-FROZEN.md):
  - 1,300 full-resolution candidate crops of 507 held-out hosts, all on-screen;
  - two blind AI-agent passes and an adjudication pass (kappa 0.711);
  - 173 real, 248 unclear, 879 not.
- **First use:** Vision v1's single `evaluate.py final`. **Second use:** this package's single `evaluate.py final`
  (2026-10-14, about 17:50 UTC). It refuses to run twice.
  - The dev thresholds file was hashed just before that run.
  - Before it, the code path was checked on a stand-in: the dev crops with shuffled dev labels.
- **Nothing was tuned on it.** Vision v2 trained on no element of the test hosts.
  - OpenAI did answer the test crops, since it labelled all 100,000 natural crops. Those answers serve only as the
    "OpenAI itself" row here.
- **Sanity check.** Recomputed with this package's code, Vision v1 and Clef match Vision v1's RESULTS.md exactly:
  - AP 0.518 and 0.615;
  - Vision v1 media at its threshold: 36 flags, 12 real;
  - rules then Vision v1: 72 kept, 26 real.
- **Missing answers.** Every judge has an answer for every test crop.

## Ranking: any problem (test, unclear left out)

| detector | slice | crops | real | AP | P at R 0.5 | R at P 0.6 | R at P 0.8 |
|---|---|---:|---:|---:|---:|---:|---:|
| **Vision v2** | all | 1,052 | 173 | **0.611** | 0.635 | 0.538 | 0.260 |
| Vision v1 | all | 1,052 | 173 | 0.518 | 0.479 | 0.318 | 0.202 |
| Clef (both prompts, Vision v1's teacher) | all | 1,052 | 173 | 0.615 | 0.583 | 0.468 | 0.283 |
| OpenAI `luna-img-p3` notFine (Vision v2's teacher) | all | 1,052 | 173 | 0.651 | 0.657 | 0.572 | 0.399 |
| OpenAI + Clef averaged | all | 1,052 | 173 | 0.686 | 0.693 | 0.607 | 0.416 |
| v1 gbt-small | all | 1,052 | 173 | 0.199 | 0.184 | 0 | 0 |
| **Vision v2** | rules stratum | 367 | 75 | 0.617 | 0.615 | 0.533 | 0.333 |
| Vision v1 | rules stratum | 367 | 75 | 0.557 | 0.470 | 0.360 | 0.333 |
| Clef | rules stratum | 367 | 75 | 0.640 | 0.623 | 0.547 | 0.440 |
| OpenAI | rules stratum | 367 | 75 | 0.596 | 0.549 | 0.453 | 0.347 |
| OpenAI + Clef | rules stratum | 367 | 75 | 0.646 | 0.644 | 0.560 | 0.360 |
| **Vision v2** | random stratum | 328 | 12 | 0.529 | 0.750 | 0.500 | 0.417 |
| Vision v1 | random stratum | 328 | 12 | 0.406 | 0.500 | 0.417 | 0.333 |
| Clef | random stratum | 328 | 12 | 0.502 | 0.700 | 0.583 | 0.333 |
| OpenAI | random stratum | 328 | 12 | 0.726 | 1.000 | 0.667 | 0.667 |
| OpenAI + Clef | random stratum | 328 | 12 | 0.719 | 1.000 | 0.750 | 0.667 |
| **Vision v2** | clef-high stratum | 258 | 85 | 0.661 | 0.733 | 0.671 | 0.306 |
| Vision v1 | clef-high stratum | 258 | 85 | 0.522 | 0.512 | 0.271 | 0.118 |
| Clef | clef-high stratum | 258 | 85 | 0.592 | 0.606 | 0.506 | 0.106 |
| OpenAI | clef-high stratum | 258 | 85 | 0.729 | 0.742 | 0.647 | 0.447 |
| OpenAI + Clef | clef-high stratum | 258 | 85 | 0.733 | 0.763 | 0.647 | 0.447 |

Notes on the table:
- The random stratum has 12 real crops, so its numbers are rough.
- Clef chose the clef-high and clef-low strata, which favours Clef.
- The clef-low stratum holds 1 real crop and is left out.
- On these labels OpenAI scores below its 0.712 on the Clef evaluation's report split (round-2 labels).
- Averaging OpenAI with Clef helps here (+0.035). On the round-2 report split it added nothing to OpenAI's dev choice.

Paired AP differences, Vision v2 minus each (host-level bootstrap, 2,000 resamples). Any problem uses each judge's
any-problem score; the families use each judge's own-family probability, the family's reals against every not:

| | vs Vision v1 | vs Clef | vs OpenAI | vs OpenAI + Clef |
|---|---|---|---|---|
| any problem | **+0.093 [0.013, 0.170] beats** | −0.004 [−0.099, 0.085] matches | −0.040 [−0.119, 0.044] matches | −0.075 [−0.151, 0.003] matches |
| text (41) | −0.056 [−0.139, 0.011] matches | **−0.207 [−0.304, −0.059] falls short** | −0.007 [−0.158, 0.139] matches | −0.176 [−0.286, −0.030] falls short |
| overflow (34) | +0.102 [−0.048, 0.227] matches | +0.121 [−0.046, 0.257] matches | +0.009 [−0.149, 0.154] matches | −0.090 [−0.204, −0.006] falls short |
| occlusion (37) | −0.093 [−0.212, 0.020] matches | −0.135 [−0.305, 0.010] matches | **+0.064 [0.003, 0.185] beats** | −0.021 [−0.109, 0.068] matches |
| media (16) | −0.045 [−0.209, 0.050] matches | −0.157 [−0.439, 0.047] matches | +0.140 [−0.172, 0.468] matches | −0.094 [−0.362, 0.171] matches |

## Per family (test; own-family probability, the family's reals against every not)

Each cell is AP / precision at recall 0.5 / recall at precision 0.6 / recall at precision 0.8.

| family (real) | Vision v2 | Vision v1 | Clef | OpenAI | OpenAI + Clef |
|---|---|---|---|---|---|
| text (41) | 0.304 / 0.175 / 0.146 / 0.073 | 0.361 / 0.174 / 0.293 / 0.098 | 0.511 / 0.348 / 0.390 / 0.341 | 0.312 / 0.244 / 0.195 / 0 | 0.480 / 0.382 / 0.341 / 0.220 |
| occlusion (37) | 0.162 / 0.111 / 0 / 0 | 0.255 / 0.119 / 0.108 / 0.027 | 0.296 / 0.268 / 0 / 0 | 0.097 / 0.120 / 0 / 0 | 0.182 / 0.136 / 0.081 / 0 |
| overflow (34) | **0.691 / 0.850 / 0.735 / 0.500** | 0.589 / 0.607 / 0.500 / 0.294 | 0.569 / 0.667 / 0.735 / 0.147 | 0.682 / 0.773 / 0.735 / 0.382 | 0.780 / 0.905 / 0.794 / 0.618 |
| media (16) | 0.759 / 0.889 / 0.750 / 0.688 | 0.804 / 1.000 / 0.812 / 0.750 | 0.916 / 1.000 / 0.938 / 0.875 | 0.619 / 0.692 / 0.688 / 0.125 | 0.853 / 0.900 / 0.938 / 0.625 |
| dark (14) | 0.039 / 0.054 / 0 / 0 | 0.037 / 0.044 / 0 / 0 | 0.039 / 0.047 / 0 / 0 | 0.060 / 0.035 / 0 / 0 | 0.044 / 0.045 / 0 / 0 |
| responsive (13) | 0.515 / 0.538 / 0.385 / 0.385 | 0.509 / 0.700 / 0.538 / 0.154 | 0.790 / 0.889 / 0.692 / 0.692 | 0.791 / 1.000 / 0.692 / 0.692 | 0.847 / 1.000 / 0.769 / 0.692 |
| blank (8) | 0.517 / 0.467 / 0.250 / 0.250 | 0.556 / 0.571 / 0.250 / 0.250 | 0.586 / 0.583 / 0.250 / 0.125 | 0.546 / 0.636 / 0.875 / 0 | 0.565 / 0.667 / 1.000 / 0 |
| leaks (6) | 0.016 / 0.020 / 0 / 0 | 0.017 / 0.024 / 0 / 0 | 0.071 / 0.114 / 0 / 0 | 0.061 / 0.007 / 0 / 0 | 0.115 / 0.115 / 0 / 0 |

Families under 15 real (dark, responsive, blank, leaks) are shown for completeness only.
- **Text.** OpenAI's own text family is weak (0.312), and Vision v2 copies it. Averaging in Clef's family answer
  during training did not carry Clef's text strength over (0.304 against Clef's 0.511).
- **Dark.** As before, no judge separates dark-scheme bugs; they are filed under text.

## Operating points and ship decisions (test, fresh-dev thresholds)

Precision counts unclear as not real. "Weighted" is the Horvitz-Thompson in-family precision over Vision v1's
9,206-crop pool.

A family ships, as a standalone detector or as a filter on its rules, only if at its dev threshold on test it meets
all three conditions:
- it flags at least 10 test crops;
- at least 60% of the flags are in-family real bugs;
- the weighted in-family precision is at least 60%.

These are Vision v1's frozen rule; the first two are this task's rule. No Vision v2 detector meets even the first two.

| detector | threshold | flags | in-family real | in-family precision [95% CI] | weighted | any-family precision | in-family recall | ships |
|---|---:|---:|---:|---|---:|---:|---:|---|
| Vision v2 media | 0.101 | 106 | 15 | 0.142 [0.088, 0.220] | 0.043 | 0.255 | 0.938 | no |
| Vision v2 text | 0.698 | 14 | 7 | 0.500 [0.268, 0.732] | 0.481 | 0.571 | 0.171 | no |
| Vision v2 responsive | 0.199 | 40 | 7 | 0.175 [0.087, 0.320] | 0.171 | 0.600 | 0.538 | no |
| media rules, filtered by Vision v2 | 0.149 | 27 | 5 | 0.185 [0.082, 0.367] | 0.185 | 0.333 | 0.312 | no |
| Vision v2 any problem (no family) | 0.715 | 159 | 72 | 0.453 [0.377, 0.530] | 0.453 | 0.453 | 0.416 | |
| Vision v1 media (its own threshold) | 0.350 | 36 | 12 | 0.333 [0.202, 0.497] | 0.259 | 0.361 | 0.750 | no |
| Vision v1 overflow (its own threshold) | 0.635 | 4 | 2 | 0.500 [0.150, 0.850] | 0.476 | 0.750 | 0.059 | no (4 flags) |
| media rules, filtered by Vision v1 | 0.301 | 16 | 5 | 0.312 [0.142, 0.556] | 0.312 | 0.375 | 0.312 | no |
| Vision v1 any problem (no family) | 0.977 | 34 | 19 | 0.559 [0.395, 0.711] | 0.552 | 0.559 | 0.110 | |
| OpenAI media | 0.05 | 115 | 16 | 0.139 [0.087, 0.214] | 0.048 | 0.252 | 1.000 | no |
| OpenAI text | 0.77 | 41 | 15 | 0.366 [0.236, 0.519] | 0.375 | 0.439 | 0.366 | no |
| text rules, filtered by OpenAI | 0.79 | 24 | 11 | 0.458 [0.279, 0.649] | 0.458 | 0.542 | 0.268 | no |
| media rules, filtered by OpenAI | 0.20 | 29 | 5 | 0.172 [0.076, 0.345] | 0.172 | 0.310 | 0.312 | no |
| OpenAI any problem (no family) | 0.73 | 233 | 99 | 0.425 [0.363, 0.489] | 0.440 | 0.425 | 0.572 | |
| Clef text | 0.710 | 17 | 14 | **0.824 [0.590, 0.938]** | **0.832** | 0.882 | 0.341 | passes (lead only) |
| Clef media | 0.186 | 86 | 15 | 0.174 [0.109, 0.268] | 0.069 | 0.221 | 0.938 | no |
| Clef occlusion | 0.477 | 13 | 6 | 0.462 [0.232, 0.709] | 0.258 | 0.462 | 0.162 | no |
| Clef responsive | 0.274 | 28 | 9 | 0.321 [0.179, 0.507] | 0.309 | 0.786 | 0.692 | no |
| text rules, filtered by Clef | 0.637 | 26 | 11 | 0.423 [0.255, 0.611] | 0.423 | 0.500 | 0.268 | no |
| media rules, filtered by Clef | 0.202 | 26 | 5 | 0.192 [0.085, 0.379] | 0.192 | 0.308 | 0.312 | no |
| Clef any problem (no family) | 6.97 | 109 | 51 | 0.468 [0.377, 0.561] | 0.466 | 0.468 | 0.295 | |
| OpenAI + Clef overflow | 0.545 | 19 | 10 | 0.526 [0.317, 0.727] | 0.520 | 0.684 | 0.294 | no |
| OpenAI + Clef text | 0.669 | 49 | 18 | 0.367 [0.247, 0.507] | 0.375 | 0.490 | 0.439 | no |
| OpenAI + Clef media | 0.124 | 103 | 16 | 0.155 [0.098, 0.238] | 0.056 | 0.243 | 1.000 | no |
| OpenAI + Clef responsive | 0.248 | 33 | 9 | 0.273 [0.151, 0.442] | 0.264 | 0.697 | 0.692 | no |
| text rules, filtered by OpenAI + Clef | 0.649 | 33 | 14 | 0.424 [0.272, 0.592] | 0.424 | 0.515 | 0.341 | no |
| media rules, filtered by OpenAI + Clef | 0.311 | 24 | 5 | 0.208 [0.092, 0.405] | 0.208 | 0.333 | 0.312 | no |
| measured rules, media | – | 34 | 5 | 0.147 | | 0.265 | 0.312 | |
| measured rules, overflow | – | 37 | 12 | 0.324 | | 0.459 | 0.353 | |
| measured rules, text | – | 108 | 15 | 0.139 | | 0.185 | 0.366 | |
| measured rules, dark | – | 97 | 3 | 0.031 | | 0.206 | 0.214 | |
| measured rules, occlusion | – | 320 | 10 | 0.031 | | 0.091 | 0.270 | |

All operating points, with per-stratum counts, are in `test-final.json`.
- Vision v2's text flags come 11 from the rules stratum (4 real) and 3 from clef-high (3 real).
- Clef's text flags come 10 from rules (9 real) and 7 from clef-high (5 real).

## As a second stage on the rules' findings (test)

A rule flags the crop, and the judge keeps it when its any-problem score reaches its dev threshold for recall 0.5
(Vision v1: its own round-2 threshold). Recall is over all 173 real test crops.

| | threshold | kept | real | precision | recall | AP within the 367 rule-flagged crops (unclear left out) |
|---|---:|---:|---:|---:|---:|---:|
| measured rules alone | – | 500 | 75 | 0.150 | 0.434 | – |
| **rules, then Vision v2** | 0.752 | 69 | 33 | **0.478** | 0.191 | 0.617 |
| rules, then Vision v1 | 0.962 | 72 | 26 | 0.361 | 0.150 | 0.557 |
| rules, then Clef | 7.08 | 50 | 28 | 0.560 | 0.162 | 0.640 |
| rules, then OpenAI | 0.79 | 86 | 35 | 0.407 | 0.202 | 0.596 |
| rules, then OpenAI + Clef | 0.882 | 74 | 35 | 0.473 | 0.202 | 0.646 |

## Why the thresholds did not transfer (diagnostic, read after the test run)

This was computed after the one test run, from labels and teacher answers only. Nothing was changed because of it.
The file is `media-diagnostic.json`.

| | dev (600) | test (1,300) |
|---|---:|---:|
| media real crops | 38 (6.3%) | 16 (1.2%) |
| media real, clef-high stratum | 29 of 162 | 10 of 350 |
| media real, rules stratum | 9 of 230 | 5 of 500 |
| crops with Clef P(media) ≥ 0.5 | 36 | 33 |
| of them, media real / unclear | 35 / 0 | 15 / 8 |
| crops with OpenAI P(media) ≥ 0.5 | 32 | 29 |
| of them, media real / unclear | 29 / 0 | 11 / 7 |

Crops the two teachers find about equally media-like are almost always media bugs to the dev labellers and less than
half the time to the test labellers.
- The protocol, instructions and sheets are the same; only the labeller agents differ.
- With one labeller pool per set, either the defects or the labellers differ, and this design cannot tell which.
- Any threshold fixed at "60% precision on dev" inherits that difference.
- Vision v1's media threshold failed the same way, on round-2 dev labels.

## Size, latency, portability (`export.json`, `portability.json`, `spec.json`)

- ONNX fp32: 4,767,031 bytes, 1,188,787 parameters. Outputs: `family` (11), `any` (notFine) and `verdict` (8). It
  matches PyTorch to 3.1e-6.
- Latency, one thread, batch 1: 0.53 ms in onnxruntime fp32, against 1.76 ms in PyTorch eager.
- `portable/score_onnx.py` is a self-contained scorer: crop letterbox and the 64 facts, copied from `common.py`.
  - It ran in a fresh venv with numpy, Pillow and onnxruntime only, under `env -i` and `python -I`, with torch not
    importable.
  - It scored 300 round-2 dev crops from their JPEGs and raw element rows in 2.0 s: 6.6 ms per crop, start-up and
    model load included.
  - Maximum difference from PyTorch: 2.8e-6; rank correlation 1.0.
- `spec.json` records the input layout, the facts in order, the output classes, the score and the fresh-dev
  thresholds. Int8 was not tried; Vision v1's dynamic int8 was off by up to 0.56.

## Spend

| item | amount |
|---|---|
| OpenAI Decisions calls | 100,027 for the 100,000 crops (the 20-call pilot labelled real crops). The 27 extra were a 10-call connection test, repeat calls for crops with no usable answer, and calls cut off when the labeller was restarted |
| OpenAI input tokens | 109,773,646 (mean 1,098 a call) |
| **OpenAI cost** | **US$10.98** at the standard $0.10 per million (no output charge), against the $25 cap; about $0.11 per 1,000 crops |
| VM | c20 (F80ads_v7), started 16:47 UTC, deallocated 17:53 UTC: about 1.1 hours; no other node was started |
| Training | 8 runs at once, 28 to 30 minutes each (9 threads per run) |
| Labeller agents | 7 sessions (3 + 3 + 1), about 6 minutes each |

## Limits

- **AI-agent labels on both sides.** Dev and test were labelled by different agent pools with the same protocol, and
  for media they disagree in calibration. Every precision here is "precision according to those labellers".
- **The test set has been used twice.** Vision v1 and Vision v2 each ran one evaluation. Vision v2 tuned nothing on
  it, but any later model compared on it is compared on a set that two rounds of reporting have already looked at.
- **Clef-chosen strata.** Half of both the dev and the test strata were chosen by Clef's score.
- **On-screen only.** The crawl has first-screen screenshots only.
- **Public-beta teacher.** OpenAI's answers come in steps of 0.01 and may change with the beta.

## What would most improve it next

1. **Calibrate the labellers before setting thresholds again.**
   - Have one labeller pool label dev and test crops mixed on the same sheets, or better, have people label both.
   - Otherwise a 60%-precision threshold on dev will keep missing on test, as it has twice now.
   - The ranking is no longer the blocker: Vision v2 ranks with Clef overall, and its media AP is 0.76.
2. **Confirm the Clef text lead** (17 flags, 14 real) on a fresh labelled batch. If it holds, Clef as a filter on the
   text rules is the first family operating point worth shipping.
3. **More, sharper teacher data.**
   - OpenAI costs $0.11 per 1,000 crops: another 150,000 full-resolution crops would cost about $17.
   - The student is at 0.611 against OpenAI's 0.651 and the average's 0.686. It trained on 74,362 crops, a third of
     them low-resolution shot crops.
4. **Teach text from Clef.** OpenAI's family answer is weak on text, and the averaged target did not carry Clef's
   strength over. Weight Clef's text probability more, or give text its own head.
5. **Dark-mode labels of their own.** Still nothing separates dark-scheme bugs from text bugs.

## Where things are (data node c20, OS disk; the node is deallocated)

Everything is under `~/vision-out/vision-v2`:
- `oa/`: the request plan, the per-batch index rows, the token keys, the answers pushed back from the Mac, and
  `luna-img-p3.jsonl` (crop id → OpenAI's verdict and family probabilities).
- `dev/`: dev hosts (salted hashes), manifest, blind sheets and keys of passes A, B and C, and labels.
- `models/`: the eight runs, each with per-epoch checkpoints and fresh-dev scores. The model is `models/A5s2/`:
  `model.pt`, and `export/` with `model.onnx`, `spec.json` and `score_onnx.py`.
- `eval/`: `selection.json`, `dev.json`, `dry-final.json` and `test-final.json`.
- `agg/`: the aggregate files copied here.

On the Mac, the session scratch folder holds only random tokens with probability vectors and the spend ledgers. No
crop or sheet was kept.
