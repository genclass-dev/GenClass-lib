# GenClass Vision v1: results (2026-10-14)

Vision v1 is a small image model distilled from Cloudflare's Clef. It judges one page element from its screenshot
crop and 64 measured facts. Code: [`vision/vision_v1`](../../vision_v1/README.md). The test set and the ship rule
were committed before any model was trained: [`TEST-FROZEN.md`](TEST-FROZEN.md). The numbers below come from one
evaluation run (`evaluate.py final`), and every file next to this one holds aggregates only.

**Every label here comes from AI agents (Claude subagents), not from people.** That covers the 1,300 fresh test
crops (two blind passes and an adjudication pass) and the 2,200 round-2 crops used as dev data (six agents).

## Answer first

- **No family ships.** At the thresholds chosen on dev, no Vision v1 detector reaches 60% in-family precision with
  at least 10 flags on the fresh test set. The same is true of Clef's own family detectors. Every family stays on
  the measured checks.
- **Against Clef, the teacher (both prompts combined):**
  - Vision v1 falls short overall: AP 0.518 against 0.615 on 1,052 test crops (173 real).
  - Per family, it falls short on **text** (AP 0.361 against 0.511; 95% host-bootstrap interval of the difference
    −0.251 to −0.002).
  - It **matches** Clef on **overflow** (0.589 against 0.569), **occlusion** (0.255 against 0.296) and **media**
    (0.804 against 0.916). In each of those the interval includes 0.
  - It beats Clef on no family.
- **Against either Clef prompt on its own,** Vision v1 does slightly better overall: AP 0.518 against 0.496
  (`clef-img-p3`, the Clef evaluation's choice) and 0.504 (`clef-imgonly-p2`). On the rule-flagged stratum it is
  below both (0.557 against 0.598 and 0.612). Clef chose two of the four strata, which favours Clef (see the test
  set below).
- **Far ahead of the earlier models and the rules.**
  - The v1 gbt-small model gets AP 0.199 on the same test crops.
  - The measured rules flag 500 crops, of which 15% are real.
  - Used as a second stage on the rules' flags, Vision v1 keeps 72, of which 36% are real; Clef keeps 64, 47% real.
- **Why nothing ships:** the dev thresholds did not transfer.
  - Media ranks well on test: own-family AP 0.80, precision 1.0 at recall 0.5. But the threshold chosen on the
    round-2 dev labels flags 36 test crops, and only 12 of them are real media bugs (33%).
  - Clef's media threshold does the same: 44 flags, 15 real.
  - The dev labels came from another protocol (round 2's six agents). Dev media was ranked almost perfectly (AP
    0.99), so the lowest threshold that kept 60% precision there sat too low for the fresh labels.
- **Small and fast.**
  - Model: MobileNetV3-small, 1.20 M parameters, 4.8 MB as ONNX fp32.
  - Latency: 0.54 ms per crop on one CPU thread (AMD EPYC 9V45, onnxruntime 1.31, batch 1). The full path (JPEG
    decode, letterbox, facts, model) is at most 5.4 ms per crop, Python start-up included. A Clef call takes about
    260 ms on the server and 520 ms seen from outside.
  - Portability: scored in a clean environment from raw crops and raw extractor rows (numpy, Pillow and
    onnxruntime only, no torch, no code from this package), it agrees with PyTorch to 1.1e-6.
- **Cost.**
  - Clef: US$55.50 for 200,688 calls (100,000 natural crops under both prompts, plus the 344 unclear dev crops).
  - Training: the chosen model took 28 minutes on 19 threads of one F80 node. All 24 runs (13 finished, 11 stopped
    early), on c20, c21 and c22 between 07:06 and 08:37 UTC, took about 10 hours of 19- or 38-thread run time.

## What was built

### Data (train hosts only)

- **Natural crops: 100,000** from round-2 train hosts (not near-duplicates). Clef labelled all of them.
  - **64,822** are every full-resolution crawl candidate crop of those hosts: the v1 model's picks, v1 rule flags
    and random visible elements, with 24 px of context, JPEG quality 90.
  - **35,178** were cut from the stored viewport shots and stratified, ten strata taking turns, 3,518 each: measured
    signals (broken images, leak patterns, contrast under 1.5:1 on a solid background, placeholder hosts, undefined
    var()), overflow, dark views, media, overlaps, small elements, contrast under 3:1, controls, text and random.
    At most 12 crops come from one view.
  - The shots are JPEG quality 55 at 0.5x (desktop) or 0.75x (phone). These crops were brought back to CSS-pixel
    size.
  - A geometry check against the crawl's full-resolution crops of the same rectangles: median correlation 0.90,
    against 0.38 for a 6 px shift.
- **Injected faults: 13,204** fault rows that the pixel check saw change (not noisy), at most 600 per recipe, 82
  recipes. Each came with 11,325 "before" crops (the same element in the page's natural view) and 8,611 matched
  clean crops of the same injected view.
- **Held out for the fresh test:** 815 train hosts, 14,228 of the natural crops. Vision v1 never trained on them.
- **Distillation check:** another 5% of hosts (4,710 crops) were kept back to measure agreement with Clef.
- The 2,200 round-2 labelled crops (val and test hosts) are dev data only. They were never trained on.

### Teacher

- Clef (`@cf/cloudflare/clef`) through the private eval worker, with the Clef evaluation's two leading prompts,
  `clef-img-p3` (image, facts, caution) and `clef-imgonly-p2` (image and tag).
- `parity.py` checked that the prompts are byte for byte those of `vision/clef/eval.py` on all 1,856 labelled crops.
  The dev/report split and the bootstrap groups also match.
- The teacher's anyProblem score is the sum of the two prompts' logits of 1 − P(family = none). On the Clef
  evaluation's dev split it scored AP 0.613, against 0.488 and 0.413 for either prompt alone. On its report split
  it scored 0.740.
- The student copies both prompts' full family (11 classes) and verdict (8 classes) distributions.

### Student

- Network: torchvision MobileNetV3-small, ImageNet weights.
- Input: the crop at CSS-pixel resolution, letterboxed to 224 x 128 (upscaled at most 2x, grey fill).
- Facts: 64 measured facts (device, scheme, page sideways scroll, box geometry, interactivity, text and contrast,
  hit test, image state, overflow and clipping, leak patterns, undefined variables, ...) pass through a small MLP and
  are joined before the head.
- Heads: four, the family and verdict answers under each of the two prompts.
- Loss: soft cross-entropy against Clef's probabilities (verdict heads weighted 0.5).
- Score: anyProblem is the sigmoid of the mean of the two family heads' logit(1 − P(none)). Family f's score is
  the mean of the two heads' P(f).
- Augmentation:
  - Every full-resolution crop is swapped, with probability 0.5, for its "degraded" copy (down to the shot scale,
    JPEG 55, back up), so resolution never tells the two sources apart.
  - Each batch is shifted by up to 8 px.
- Optimiser: AdamW, head learning rate 5e-3, backbone 2e-3, cosine schedule, 12 epochs of 81,062 crops, bf16
  autocast.
- Runs were pinned to a quarter of the node (19 threads). One process spanning both NUMA nodes with 78 threads ran
  3 to 5 times slower.

### Model choice (dev only)

Each run is scored by its dev AP: the student's anyProblem on the 1,856 round-2 crops that are not unclear (139
real), averaged over its last three epochs. The run that ranked first is the model, and its final checkpoint is
used. Full-resolution input beat degraded input on dev in every run, so the test used full-resolution crops.

| run | backbone | input | learning rate (head / backbone) | injected faults | epochs | dev AP | minutes |
|---|---|---|---|---|---:|---:|---:|
| **f-s-lr5 (chosen)** | MobileNetV3-small | 224 x 128 | 5e-3 / 2e-3 | no | 12 | **0.651** | 28 |
| f-s-lr3 | MobileNetV3-small | 224 x 128 | 3e-3 / 1.2e-3 | no | 12 | 0.645 | 28 |
| f-s-lr3-anyT | small + a combined-anyProblem head | 224 x 128 | 3e-3 / 1.2e-3 | no | 12 | 0.637 | 27 |
| f320-s-lr3 | MobileNetV3-small | 320 x 192 | 3e-3 / 1.2e-3 | no | 12 | 0.637 | 38 |
| f-s-lr2-e20 | MobileNetV3-small | 224 x 128 | 2e-3 / 8e-4 | no | 20 | 0.630 | 52 |
| f-l-lr2 | MobileNetV3-large | 224 x 128 | 2e-3 / 8e-4 | no | 10 | 0.628 | 49 |
| f-s-lr2-seed2 | MobileNetV3-small, seed 2 | 224 x 128 | 2e-3 / 8e-4 | no | 12 | 0.616 | 37 |
| f-s-anyT | small + a combined-anyProblem head | 224 x 128 | 2e-3 / 8e-4 | no | 12 | 0.615 | 27 |
| f-s-deg8 | small, degraded copy at p 0.8 | 224 x 128 | 2e-3 / 8e-4 | no | 12 | 0.607 | 30 |
| f320-s-lr2 | MobileNetV3-small | 320 x 192 | 2e-3 / 8e-4 | no | 12 | 0.605 | 37 |
| f-s-inj0-lr2 | MobileNetV3-small | 224 x 128 | 2e-3 / 8e-4 | no | 12 | 0.604 | 27 |
| f-s-inj0 | MobileNetV3-small | 224 x 128 | 1e-3 / 4e-4 | no | 12 | 0.585 | 27 |

Two seeds of the same 2e-3 configuration score 0.604 and 0.616, so differences under about 0.01 are noise.

The first runs had about 85% of the Clef labels, MobileNetV3-small and learning rate 1e-3. Dev AP after 3 epochs:

| run | dev AP |
|---|---:|
| no injected faults | 0.524 |
| injected faults at weight 0.5 | 0.480 |
| injected faults at weight 1.0 | 0.372 |
| injected faults at weight 0.5, no degraded copies | 0.436 |

With all labels, weight 0.2 was even with no injected faults (0.578 against 0.580 over epochs 8 to 10). The
injected faults teach the recipes, not what visitors see, so the final model has none. EfficientNet-B0 ran at
about 170 crops a second, a third of MobileNetV3-small's speed, and was behind it after 2 epochs (0.446 against
0.469, both with injected faults at 0.5). It was stopped.

## The fresh test set

- **Composition** (`TEST-FROZEN.md`): 1,300 full-resolution crawl candidate crops of 507 held-out train hosts, all
  on-screen. Strata: 500 rule-flagged, 350 random visible elements, 350 with the highest teacher scores, 100 from
  the lower half of teacher scores.
- **Labels:** two blind passes by separate agents. Verdict agreement was 85.3% (kappa 0.711), and family agreement
  92.4% when both said real. 202 crops were adjudicated.
- **Result:** 173 real (text 41, occlusion 37, overflow 34, media 16, dark 14, responsive 13, blank 8, leaks 6,
  other 2, mixed 2), 248 unclear, 879 not.
- **Real bugs by stratum:** rules 75 of 500, random 12 of 350, clef-high 85 of 350, clef-low 1 of 100.
- **Bias.** Clef chose two strata, so Clef's numbers on the pooled set lean its way. The rules and random strata
  were not chosen by Clef. Weighted precision (Horvitz-Thompson over the 9,206-crop pool) corrects the operating
  points for the strata.
- **On-screen only.** The crawl kept screenshots of the first screen only. Nothing here covers elements below the
  fold.

## Ranking: any problem (test, unclear left out)

| detector | slice | crops | real | AP | P at R 0.5 | R at P 0.6 | R at P 0.8 |
|---|---|---:|---:|---:|---:|---:|---:|
| **Vision v1** | all | 1,052 | 173 | **0.518** | 0.479 | 0.318 | 0.202 |
| Clef (both prompts, the teacher) | all | 1,052 | 173 | 0.615 | 0.583 | 0.468 | 0.283 |
| Clef `clef-img-p3` | all | 1,052 | 173 | 0.496 | 0.442 | 0.277 | 0.139 |
| Clef `clef-imgonly-p2` | all | 1,052 | 173 | 0.504 | 0.492 | 0.202 | 0.069 |
| v1 gbt-small | all | 1,052 | 173 | 0.199 | 0.184 | 0 | 0 |
| Vision v1 | rules stratum | 367 | 75 | 0.557 | 0.470 | 0.360 | 0.333 |
| Clef (teacher) | rules stratum | 367 | 75 | 0.640 | 0.623 | 0.547 | 0.440 |
| Clef `clef-img-p3` | rules stratum | 367 | 75 | 0.598 | 0.633 | 0.520 | 0.400 |
| Clef `clef-imgonly-p2` | rules stratum | 367 | 75 | 0.612 | 0.568 | 0.480 | 0.293 |
| v1 gbt-small | rules stratum | 367 | 75 | 0.218 | 0.206 | 0 | 0 |
| Vision v1 | random stratum | 328 | 12 | 0.406 | 0.500 | 0.417 | 0.333 |
| Clef (teacher) | random stratum | 328 | 12 | 0.502 | 0.700 | 0.583 | 0.333 |
| Clef `clef-img-p3` | random stratum | 328 | 12 | 0.438 | 0.300 | 0.333 | 0.333 |
| Clef `clef-imgonly-p2` | random stratum | 328 | 12 | 0.379 | 0.500 | 0.250 | 0 |
| v1 gbt-small | random stratum | 328 | 12 | 0.038 | 0.041 | 0 | 0 |
| Vision v1 | clef-high stratum | 258 | 85 | 0.522 | 0.512 | 0.271 | 0.118 |
| Clef (teacher) | clef-high stratum | 258 | 85 | 0.592 | 0.606 | 0.506 | 0.106 |

The random stratum has 12 real crops, so its numbers are rough. On the Clef evaluation's open question, image + tag
only against image + facts, the fresh labels lean slightly to image + tag only overall and on the rule-flagged
stratum (0.504 and 0.612 against 0.496 and 0.598), and the other way on the random stratum. The two prompts together
beat either one everywhere, which is why the teacher uses both.

## Per family (test, at least 15 in-family real; the family's reals against every not)

| family (real) | Vision v1 AP / P at R 0.5 / R at P 0.8 | Clef AP / P at R 0.5 / R at P 0.8 | AP difference [95% CI] | verdict |
|---|---|---|---|---|
| text (41) | 0.361 / 0.174 / 0.098 | 0.511 / 0.348 / 0.341 | −0.150 [−0.251, −0.002] | falls short |
| overflow (34) | 0.589 / 0.607 / 0.294 | 0.569 / 0.667 / 0.147 | +0.020 [−0.121, 0.153] | matches |
| occlusion (37) | 0.255 / 0.119 / 0.027 | 0.296 / 0.268 / 0 | −0.041 [−0.178, 0.070] | matches |
| media (16) | 0.804 / 1.000 / 0.750 | 0.916 / 1.000 / 0.875 | −0.112 [−0.294, 0.033] | matches |

Dark has 14 in-family real crops, under the bar of 15. Both models file most dark-scheme bugs under text, as the
Clef evaluation found.

## Operating points and ship decisions (test, dev thresholds)

Precision counts unclear as not real. "Weighted" is the Horvitz-Thompson in-family precision over the pool.

| detector | flags | in-family real | in-family precision [95% CI] | weighted | any-family precision | in-family recall | ships |
|---|---:|---:|---|---:|---:|---:|---|
| Vision v1 media | 36 | 12 | 0.333 [0.202, 0.497] | 0.259 | 0.361 | 0.750 | no |
| Vision v1 overflow | 4 | 2 | 0.500 [0.150, 0.850] | 0.476 | 0.750 | 0.059 | no (4 flags) |
| media rules, filtered by Vision v1 | 16 | 5 | 0.312 [0.142, 0.556] | 0.312 | 0.375 | 0.312 | no |
| overflow rule, filtered by Vision v1 | 1 | 0 | 0 | 0 | 0 | 0 | no |
| Clef media | 44 | 15 | 0.341 [0.219, 0.489] | 0.200 | 0.409 | 0.938 | no |
| Clef overflow | 16 | 6 | 0.375 [0.185, 0.614] | 0.372 | 0.438 | 0.176 | no |
| Clef responsive | 6 | 5 | 0.833 [0.436, 0.970] | 0.844 | 0.833 | 0.385 | no (6 flags) |
| media rules, filtered by Clef | 15 | 5 | 0.333 [0.152, 0.583] | 0.333 | 0.533 | 0.312 | no |
| overflow rule, filtered by Clef | 11 | 4 | 0.364 [0.152, 0.646] | 0.364 | 0.364 | 0.118 | no |
| occlusion rules, filtered by Clef | 3 | 1 | 0.333 | 0.333 | 0.333 | 0.027 | no |
| measured rules, media | 34 | 5 | 0.147 | | 0.265 | 0.312 | |
| measured rules, overflow | 37 | 12 | 0.324 | | 0.459 | 0.353 | |
| measured rules, text | 108 | 15 | 0.139 | | 0.185 | 0.366 | |
| measured rules, dark | 97 | 3 | 0.031 | | 0.206 | 0.214 | |
| measured rules, occlusion | 320 | 10 | 0.031 | | 0.091 | 0.270 | |
| Vision v1 any problem (no family) | 34 | 19 | 0.559 [0.395, 0.711] | 0.552 | 0.559 | 0.110 | |
| Clef any problem (no family) | 63 | 38 | 0.603 [0.480, 0.715] | 0.608 | 0.603 | 0.220 | |

No dev threshold exists for Vision v1 text, dark, occlusion, leaks, blank, controls, responsive or other, so those
families have no operating point and do not ship. On dev, no threshold reached 60% in-family precision with at least
5 flags; dev holds 12 text, 17 dark, 20 occlusion and 8 leaks real crops.

## As a second stage on the rules' findings (test)

The rules flag a crop, and the score keeps it when it reaches the dev threshold for recall 0.5. Recall is over
all 173 real test crops.

| | flagged | real | precision | recall |
|---|---:|---:|---:|---:|
| measured rules alone | 500 | 75 | 0.150 | 0.434 |
| rules, then Vision v1 | 72 | 26 | 0.361 | 0.150 |
| rules, then Clef (teacher) | 64 | 30 | 0.469 | 0.173 |

## Dev, for continuity with the Clef evaluation (round-2 labels; the model was chosen on these crops)

On the Clef evaluation's report split (1,444 crops, 114 real):

- **Vision v1:** AP 0.671, precision 0.738 at recall 0.5, recall 0.421 at precision 0.8.
- **Clef:** RESULTS.md of that evaluation gives 0.576 for `clef-img-p3` and 0.668 for `clef-imgonly-p2`. The
  teacher (both prompts) scores 0.740.

Per family on that split (Vision v1 / teacher):

| family | Vision v1 | teacher |
|---|---:|---:|
| overflow | 0.635 | 0.647 |
| media | 0.993 | 0.993 |
| dark | 0.020 | 0.024 |
| occlusion | 0.266 | 0.372 |

The model choice read these crops, so these numbers flatter Vision v1. The fresh test set is the evidence.

On the 420 crops of train hosts that round 2's training agent labelled (311 not unclear, 120 real), Clef scores AP
0.828 (`clef-img-p3`) and 0.836 (`clef-imgonly-p2`); the two prompts together reach 0.887.

## Size, latency, portability (`export.json`, `portability.json`, `spec.json`)

- ONNX fp32: 4,773,529 bytes, 1,196,102 parameters. It matches PyTorch to 1.4e-6.
- Dynamic int8 (`model.int8.onnx`, 1.37 MB) is not usable: it is off by up to 0.56 in anyProblem and is slower
  (6.5 ms), because the convolutions become ConvInteger. Ship fp32, or try static quantisation with calibration.
- Latency, one thread, batch 1: 0.54 ms (onnxruntime fp32), against 1.81 ms in PyTorch eager.
- `spec.json` describes everything a port needs: the crop rule, the letterbox (size, scale, resampling, fill,
  placement), the 64 facts in order with the tag groups they use (no category codes), the output classes, the
  anyProblem formula and the dev thresholds.
- `portable/score_onnx.py` is a self-contained scorer. In a fresh environment (numpy, Pillow and onnxruntime only,
  `env -i`, `python -I`) it scored 300 dev crops from their JPEGs and raw element rows: maximum difference from
  PyTorch 1.1e-6, rank correlation 1.0.

## Limits

- **AI-agent labels.** Both the dev and the test labels come from AI agents, not people. On the test, two separate
  passes agreed at kappa 0.711. The dev and test labels follow two different protocols, and the operating points did
  not transfer between them.
- **On-screen only.** The crawl has first-screen viewport screenshots only.
- **Source resolution.** The 35,178 shot crops come from JPEG 55 shots at 0.5x or 0.75x. Test crops are
  full-resolution.
- **Clef-chosen strata.** Clef chose half of the test strata.
- **No hand check** of the student's flags outside the labelled set; there was nothing to ship.

## What would most improve it next

1. **Thresholds from the test protocol.** Have the same blind two-pass protocol label a fresh dev set, and set
   thresholds there. The ranking is good enough on media (precision 1.0 at recall 0.5) and close on overflow. The
   failure is a threshold calibrated on round-2 labels. Better still, use people for the next labels, at least for
   the test set.
2. **Full-resolution, full-page captures for every element**, not only for the six crawl candidates per view. That
   gives the student the teacher's view (it falls short most on text, where detail matters) and covers below the
   fold.
3. **More distillation data.** The student reaches 84% of the teacher's AP after one pass over 81,062 crops. Clef
   labelling costs $0.55 per 1,000 crops under both prompts, so another 150,000 full-resolution crops would fit in
   the original $150 budget.
4. **Dark-mode labels of their own.** Neither Clef nor the student separates dark-scheme bugs from text bugs.

## Where things are (data node c20, OS disk; the node is deallocated)

- Model: `~/vision-out/vision-v1/models/f-s-lr5/` (`model.pt`, `train.json`, dev scores, `export/` with
  `model.onnx`, `model.int8.onnx`, `spec.json`, `score_onnx.py`). The other runs are in `models/`. The c21 and c22
  runs were not copied back, apart from four model files: f-s-lr5, f-s-lr3, f-l-lr2, f-s-lr2-e20.
- Index and facts: `~/vision-out/vision-v1/index/` (`nat.jsonl`, `inj.jsonl`, `lab.jsonl`; `shots.jsonl` names
  hosts and stays there). Shot crops: `~/vision-out/vision-v1/crops/`. Pack: `pack/` (224 x 128; the 320 x 192
  pack was deleted to free disk, and `VV1_INPUT=320x192 pack.py --sets lab,nat` rebuilds it in about 5 minutes).
  The eval key was deleted from the node.
- Clef answers: `~/vision-out/vision-v1/clef/<prompt>/answers-*.jsonl`.
- Fresh test set: `~/vision-out/vision-v1/test/`. That holds `manifest.jsonl` (random ids), `labels.json`, the
  blind sheets and keys of passes A, B and C, `results-final.json` and `heldout.json`. Its digests are in
  TEST-FROZEN.md.
