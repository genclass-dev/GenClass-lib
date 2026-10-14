# Visual-bug classifier v2: training and evaluation on real pages, 2026-10-14

Data: the v2 crawl and training set (`README.md` in this folder: 6,011 AI-builder and 1,209 control homepages, one load
each, traceless injection, provenance audit passed at ROC AUC 0.528). Labels: 2,200 element crops of held-out pages
labelled by 6 labellers, plus 420 crops of training pages labelled for training only. Code: `vision/label/resolve.py`,
`vision/label/sheets_extra.py`, `vision/train/train_v2.py`, `eval_v2.py`, `handcheck_v2.py`, `export_v2.py`,
`detect_v2.mjs`. Everything ran on c20 (F80ads_v7, 80 vCPU) between 03:25 and 06:30 UTC on 2026-10-14. Every number
below is in `train/eval-v2.json` (final run, "run B"), `train/run-a/eval-v2.json` (the same pipeline without the
training-only labels, "run A"), `train/train.json`, `train/search.json`, `train/export-v2.json`, `labels.json`,
`labels-extra.json` and `handcheck-hc*.json`. No file names a crawled site; crop ids carry no host.

## Answer first

- **v2 beats the measured checks on real pages, by precision.** On the 1,114 labelled crops of 522 held-out sites, the
  pooled v2 model at 0.1% of clean elements flagged (threshold set on dev) flags 79 crops, 33 real (42%); its stack
  with the labelled-crop model flags 68, 38 real (56%). The measured checks flag 424, 58 real (14%). A blind hand
  check of 24 other flags of the pooled model on 22 sites found 11 real (46%). v1's model had 1 real bug in 99 flags.
  The checks still find more of the labelled real bugs (58 of 73 against 38), partly because 800 of the 2,200 crops
  were chosen because a check flagged them.
- **Ship criterion** (fixed before the test numbers were read): a family ships in the scanner only if, at a threshold
  chosen on dev (val), at least 60% of its flags on held-out real pages are real bugs. That means at least 10 flags
  on the labelled test crops, with unclear counted as not real, and a blind hand check of its other test flags must
  agree. Otherwise the family stays on measured checks.
- **Two families ship.**
  - **media**, as a filter on the measured media checks: a finding of image-broken, media-failed, text-placeholder or
    image-distorted is reported only when the v2 media score (a stack of the media model and the labelled-crop
    model) is at least 0.026. On labelled test crops it flags 27, 19 real (70%, 95% CI 0.52 to 0.84), and finds 19 of
    the 21 labelled media bugs. The checks alone flag 44, 19 real (43%), and find the same 19. Blind hand check of
    other test flags: 25 of 30 real (9 sites); of the check findings it drops, 1 of 29 is real.
  - **responsive**: the v2 responsive stack at 0.561. It flags 10 labelled test crops, 7 real (70%, CI 0.40 to 0.89).
    The hand check found 10 of 11 other flags real (4 sites). It finds 6 of the 30 labelled overflow and responsive
    bugs, so it is a precise detector of pages wider than the screen, not a replacement for page-overflow-x (25 of 56
    real, 45%). The evidence is thin: 10 flags, the minimum.
- **Everything else stays on measured checks:** overflow (as a family), text and dark contrast, occlusion, leaks,
  styles, controls, blank, motion, design and other. No threshold reached 60% on dev, or (overflow) the dev choice
  gave 5 test flags.
- **Labels made the difference.** Without the 420 training-only labels (run A), the pooled model's out-of-fold average
  precision on the labelled dev crops was 0.215. With them (run B) it was 0.358, and on test 0.202 against 0.415.
  Only one detector passed in run A: the image-broken filter, 14 of 17 real against 14 of 18 for the check alone.
- **Pure media models failed the hand check.** On labelled crops they looked good (the media model 13 of 18 real),
  but most of their flags fall outside the labelled set, and there they were mostly correct elements: 10 of 30 and
  8 of 30 real. That is why the hand check is part of the criterion.
- Shipping bundle `train/visual-v2.json`: 3 tree models, 199,053 B (56,850 B gzip). It costs 12.8 µs per element in
  the reference JS evaluator (Node 22, one thread on c20), about 3 ms for a median view of 229 rows. JS and LightGBM
  agree to 2.3e-7.

## 1. Labels

### The labelling set (6 labellers, held-out pages)

`label/sheets.py` cut 2,200 crops from natural (never injected) views of val and test hosts that are not
near-duplicates: 800 a v1 rule flagged, 700 the v1 model chose and no rule flagged, 700 random visible elements, at
most 2 per page and device, on 184 blind sheets (nothing shows the source). Six labellers gave 2,408 verdicts (real,
unclear, not) with a family. `label/resolve.py` joins them to the crop sidecars and training-set rows (all 2,200
found) and resolves them:

| | count |
|---|---:|
| verdicts / crops | 2,408 / 2,200 |
| crops labelled twice (overlapping sheets) | 208 |
| agreement on the verdict (crops labelled twice) | 184 of 208 (88.5%) |
| Cohen's kappa (two raters, three verdicts) | 0.705 |
| vote pairs: not/not, unclear/unclear, real/real | 149, 23, 12 |
| vote pairs: not and unclear, real and unclear, real and not | 14, 6, 4 |
| resolved verdicts: real / unclear / not | 139 / 344 / 1,717 |

Resolution: one verdict is kept; two that agree are kept; two that disagree become unclear (as instructed). The
family is the first labeller's unless it was "none".

| split | crops | sites | real | unclear | not | real by family |
|---|---:|---:|---:|---:|---:|---|
| val (dev) | 1,086 | 519 | 66 | 142 | 878 | overflow 17, media 12, dark 11, text 9, occlusion 9, leaks 6, responsive 2 |
| test | 1,114 | 522 (871 page views) | 73 | 202 | 839 | overflow 25, media 21, occlusion 11, dark 6, responsive 5, text 3, leaks 2 |

By the source that chose the crop (both splits): v1 rule flags 111 real, 240 unclear, 449 not (of 800); v1 model
picks 13, 35, 652 (of 700); random visible elements 15, 69, 616 (of 700). Per v1 rule, over every labelled crop it
flagged: image-broken 19 real of 23 (0.83), text-template-leak 5 of 12, page-overflow-x 39 of 102 (0.38),
text-invisible 14 of 65, image-distorted 11 of 58, click-blocked 1 of 7, control-unreachable 22 of 459 (0.05; 174
unclear, mostly elements under consent banners), css-var-undefined 0 of 55, font-failed 0 of 21.

Groups used when matching a flag's family to a labelled bug: overflow with responsive, and text with dark, because the
labellers did not separate them consistently. For example, one crop got real/overflow and real/responsive from its
two labellers.

### Training-only labels (train hosts, labelled by the training agent)

Run A showed that 66 labelled real bugs on dev were the bottleneck: no family reached 60% on dev. So
`label/sheets_extra.py` cut 420 more crops from natural views of TRAIN hosts that are not near-duplicates, stratified by
the v1 rule that flagged them. The strata: page-overflow-x 120, text-invisible 60, image-distorted 48,
control-unreachable 48, image-broken 24, text-template-leak 24, css-var-undefined 12, font-failed 6, click-blocked 6,
v1 model picks 36, random 36. At most 2 per page and device, on 35 blind sheets. The training agent labelled them with
the same three verdicts: 120 real, 109 unclear, 191 not. Real by family: overflow 49, media 29, responsive 13,
leaks 11, text 11, occlusion 4, dark 3. These labels only enter training rows. They never choose a threshold, never
calibrate and never evaluate: dev is still the labellers' val crops, and test the labellers' test crops. This
labeller marked a larger share of rule flags real (119 of 348) than the six labellers did (111 of 800). The
difference comes partly from the strata (120 page-overflow-x crops) and possibly from a more lenient reading. It can
only move the models, not the numbers they are judged by.

Public copies: `labels.json` and `labels-extra.json`. Each entry has the crop id, split, verdict, family, the votes
without notes, device, scheme, group, stratum, sources and v1 rules. Hosts and the labellers' notes stay on c20
(`~/vision-out/v2/labels*.json`).

## 2. Data and splits

Splits are by host after near-duplicate removal (build_set.mjs). Test hosts are read only by `eval_v2.py` and the
hand check.

| split | hosts (AI-builder / control) | natural rows | natural views | fault rows | fault rows the pixel check saw change at rest (not noisy) |
|---|---|---:|---:|---:|---:|
| train | 5,575 (4,656 / 919) | 5,249,035 | | 121,521 | 25,536 |
| val (dev) | 700 (571 / 129) | 657,424 | 1,877 | 15,019 | 3,174 |
| test | 699 (568 / 131) | 698,865 | 1,850 | 14,052 | 3,066 |

Val hosts with labelled crops (519) are cut into 5 folds by host (SHA-1 of the host). Each fold's crops are scored by
a model trained with the other 4 folds' crops (out of fold, OOF). Those scores choose the ship thresholds and the
calibration. The final models train with every val crop.

## 3. Method

### Rows of a family model (`train_v2.py`)

- **Positives:** fault rows of the family whose pixel verdict is "seen" and not noisy: the fault changed at least
  max(16 px, 1% of the box) inside the element's box at rest, and the page was not animating. Unseen, out-of-viewport
  and noisy fault rows, and faults of other families, are left out. Labelled real bugs of the family's group are
  positives too: val folds in training plus the training-only labels, each with weight alpha x positives / labelled
  real bugs.
- **Negatives:**
  - m matched clean elements per positive: natural rows no measured signal marks, plus unlabelled rows of injected
    views (which passed the provenance audit). They match on tag, role, area band (floor of log2 of area) and
    device, with tag, area band and device as the fallback key. 7 of 25,536 pooled positives had neither.
  - A background sample of natural rows, total weight equal to the matched rows'.
  - Control rows (correct lookalikes), weight 3.
  - Labelled not-bugs, weight beta x positives / labelled not-bugs. Unclear crops are left out.
- **Inputs:** the 110 matrix columns minus pVw, pVh and pDark, plus the box relative to the viewport (113). This is the
  input set the provenance audit passed on (ROC AUC 0.528; best single input 0.506).
- **Models:** 13 family models and a pooled model (all families). Early stopping reads val rows: seen faults of the
  family against matched and background val rows. It never reads labelled crops.
- **Labelled-crop model `lab`:** a small LightGBM (depth 3, 7 leaves, 150 trees). It trains only on labelled crops,
  real against not: the val folds plus the training-only labels. Its inputs are the same 113 columns plus the 14 v1
  rule bits.
- **Stacks `<family>+lab`:** a logistic regression of the family model's and lab's logits, fitted on OOF val crops
  (target: real bug of the group), with its own out-of-fold scores for dev.
- **Hybrid (check filter):** a measured check's flag is kept when a v2 score is at least t. For each family and each
  rule, the score and t are chosen on dev. Among the labelled val crops the check flags, t is the lowest threshold
  whose OOF flags are at least 60% real with at least 5 of them. The score chosen is the one that keeps the most real
  bugs at its t; ties go to the higher dev precision, then to the order family model, its stack, lab, pooled, pooled
  stack. The labelled crops a check flags are a random sample of its flags, so precision on them estimates the
  hybrid's precision on all its flags. That is not true of a model's own flags. A first evaluation compared the
  wrong quantities in this tie-break: real bugs over threshold instead of real bugs over flags. It picked the media
  model (11 of 18 on dev) over media+lab (11 of 17). The fix was made before the hand check of the shipped filter,
  and both are reported.

### Random search

Run A: 16 random settings of the pooled model, scored by the OOF average precision on the labelled val crops (real
against everything else). 15 ran; the 16th, a slow 127-leaf setting, was stopped after 14 minutes. Run B: 6 settings
around the best. Both runs picked the same settings: 15 leaves, learning rate 0.1, min_data_in_leaf 20, feature
fraction 0.6, lambda_l2 0, m 20 matched negatives, 400,000 background rows, alpha 2.0, beta 0.25. OOF average
precision with them: 0.215 in run A and 0.358 in run B (run B trial 4, 31 leaves at learning rate 0.05, tied at 0.358).
Higher alpha (labelled real bugs weighted up) helped in every pair of trials that differed in it. Every family model
uses the chosen settings.

Training rows of the run-B final models (train split):

| model | positives (seen faults) | matched | background (weight) | controls | labelled real (weight each) | labelled not (weight each) | trees |
|---|---:|---:|---|---:|---|---|---:|
| pooled `any` | 25,536 | 510,580 | 400,000 (1.28) | 3,928 | 186: 66 val + 120 extra (274.6) | 1,069: 878 val + 191 extra (5.97) | 278 |
| `media` | 1,623 | 32,460 | 400,000 (0.081) | 3,928 | 41: 12 + 29 (79.2) | 1,069 (0.38) | 36 |
| `responsive` | 2,168 | 43,340 | 400,000 (0.108) | 3,928 | 81: 19 + 62, group overflow and responsive (53.5) | 1,069 (0.51) | 264 |
| `lab` | | | | | 186 real of 1,255 labelled crops (944 val, 311 extra) | | 150 |

Top inputs by gain share: `media` inv 0.24, cmp 0.14, hs 0.09, br 0.08, aspect 0.06; `responsive` x 0.24, br 0.13,
yr 0.09, pSideways 0.08, rr 0.07; `lab` rr 0.25, rule image-broken 0.11, rule text-invisible 0.06, rule
page-overflow-x 0.05, lkN 0.05; pooled `any` yr 0.31, c2 0.29, area 0.22, c1 0.09.

### Operating points

All chosen on dev and applied unchanged to test:

- **frr-0.1% and frr-1%:** 0.1% and 1% of dev natural elements flagged.
- **ship:** the lowest threshold at which at least 60% of the OOF-scored labelled dev crops it flags are real, with
  at least 5 of them.
- **hybrid:** as above.

The measured checks have one fixed point (`common.rules`, the VISUAL.md thresholds as far as one row expresses them).

## 4. Real pages: labelled test crops

Cells: flags / real / unclear / not on the 1,114 labelled test crops. Precision is real / flags with unclear counted
against, 95% Wilson interval in parentheses. Recall is the labelled real bugs of the family's group that are flagged.
"Covers" is the share of the model's flags on all 698,865 natural test elements that fall on a labelled crop.

### Measured checks (rules), test

| family | checks | flags / real / unclear / not | precision | real bugs of the group flagged | natural elements flagged (FRR) | recall on seen injected faults of the family |
|---|---|---|---|---|---:|---:|
| media | image-broken, media-failed, text-placeholder, image-distorted | 44 / 19 / 5 / 20 | 0.43 (0.30 to 0.58) | 19 of 21 | 933 (0.13%) | 0.034 |
| overflow | page-overflow-x, scroll-lock-stuck | 56 / 25 / 18 / 13 | 0.45 (0.32 to 0.58) | 24 of 30 | 0.04% | 0.210 |
| text | text-invisible, font-failed | 40 / 4 / 16 / 20 | 0.10 (0.04 to 0.23) | 4 of 9 | 0.01% | 0.133 |
| occlusion | click-blocked, control-unreachable, dialog-covered | 248 / 9 / 102 / 137 | 0.04 (0.02 to 0.07) | 5 of 11 | 0.25% | 0.000 |
| leaks | text-template-leak | 2 / 1 / 1 / 0 | 0.50 (0.09 to 0.91) | 0 of 2 | 0.01% | 0.812 |
| styles | css-var-undefined | 35 / 0 / 0 / 35 | 0.00 (0.00 to 0.10) | | 0.05% | 0.058 |
| all | every check | 424 / 58 / 142 / 224 | 0.14 (0.11 to 0.17) | 58 of 73 | 0.50% (27.1% of pages) | 0.101 |
| all | without the static interaction stand-ins | 176 / 49 / 40 / 87 | 0.28 (0.22 to 0.35) | 49 of 73 | 0.25% | 0.078 |

Per check: image-broken 18 / 14 (0.78), page-overflow-x 56 / 25 (0.45), text-template-leak 2 / 1, image-distorted 26 / 5
(0.19), text-invisible 37 / 4 (0.11), control-unreachable 243 / 9 (0.04), css-var-undefined 35 / 0, click-blocked 5 / 0,
font-failed 3 / 0.

### v2 models, test (run B)

| model | point (dev threshold; OOF dev flags / real) | flags / real / unclear / not | precision | real bugs of the group flagged | covers |
|---|---|---|---|---|---:|
| pooled `any` | frr-0.1% (0.639) | 79 / 33 / 22 / 24 | 0.42 (0.32 to 0.53) | 33 of 73 | 12% |
| pooled `any` | frr-1% (0.156) | 264 / 56 / 72 / 136 | 0.21 (0.17 to 0.27) | 56 of 73 | 4% |
| `any+lab` | frr-0.1% (0.220) | 68 / 38 / 19 / 11 | 0.56 (0.44 to 0.67) | 38 of 73 | 9% |
| `any+lab` | frr-1% (0.060) | 211 / 57 / 67 / 87 | 0.27 (0.21 to 0.33) | 57 of 73 | 3% |
| `lab` | frr-1% (0.655) | 50 / 27 / 16 / 7 | 0.54 (0.40 to 0.67) | 27 of 73 | 0.4% |
| `media` | ship (0.704; 18 / 11) | 18 / 13 / 2 / 3 | 0.72 (0.49 to 0.88) | 13 of 21 | 15% |
| `media` | frr-0.1% (0.199) | 43 / 20 / 5 / 18 | 0.47 (0.33 to 0.61) | 20 of 21 | 4% |
| `media+lab` | ship (0.030; 30 / 18) | 40 / 26 / 6 / 8 | 0.65 (0.50 to 0.78) | 20 of 21 | 8% |
| `responsive` | ship (0.979; 5 / 3) | 11 / 8 / 2 / 1 | 0.73 (0.43 to 0.90) | 7 of 30 | 9% |
| `responsive` | frr-0.1% (0.572) | 27 / 16 / 7 / 4 | 0.59 (0.41 to 0.75) | 14 of 30 | 5% |
| `responsive+lab` | ship (0.561; 10 / 6) | 10 / 7 / 2 / 1 | 0.70 (0.40 to 0.89) | 6 of 30 | 9% |
| `overflow` | ship (0.983; 11 / 7) | 4 / 2 / 1 / 1 | 0.50 (0.15 to 0.85) | 2 of 30 | 19% |
| `overflow+lab` | ship (0.534; 15 / 10) | 5 / 2 / 2 / 1 | 0.40 (0.12 to 0.77) | 2 of 30 | 38% |
| `overflow+lab` | frr-1% (0.011) | 115 / 52 / 33 / 30 | 0.45 (0.36 to 0.54) | 26 of 30 | 1% |
| `text` | frr-0.1% (0.124) | 21 / 4 / 7 / 10 | 0.19 (0.08 to 0.40) | 4 of 9 | 4% |
| `occlusion` | frr-0.1% (0.122) | 23 / 3 / 9 / 11 | 0.13 (0.05 to 0.32) | 1 of 11 | 4% |
| `leaks+lab` | frr-0.1% (0.005) | 15 / 8 / 4 / 3 | 0.53 (0.30 to 0.75) | 1 of 2 | 2% |

The blank, controls, dark, design, motion, other and styles models never reach 60% on dev, and on test none flags more
than 2 real crops at frr-0.1%. They recognise their injected faults (section 6) and do not find real bugs on these
pages. Average precision on the labelled test crops (real against the rest): pooled `any` 0.415 (ROC AUC 0.845),
`any+lab` 0.482 (0.874), `lab` 0.447 (0.882), `media+lab` 0.483, media group 0.754.

### Hybrids (measured check filtered by a v2 score), test

| target | check alone: flags / real, precision | score chosen on dev | t | OOF dev flags / real | hybrid: flags / real / unclear / not | precision | real bugs of the group kept | ships |
|---|---|---|---:|---|---|---|---|---|
| media family | 44 / 19, 0.43 | `media+lab` | 0.026 | 17 / 11 | 27 / 19 / 2 / 6 | **0.70 (0.52 to 0.84)** | 19 of 21 | **yes** |
| image-broken | 18 / 14, 0.78 | `media` | 0.804 | 5 / 5 | 9 / 7 / 2 / 0 | 0.78 (0.45 to 0.94) | 7 of 21 | no (9 flags) |
| image-distorted | 26 / 5, 0.19 | `media` | 0.567 | 10 / 6 | 9 / 5 / 1 / 3 | 0.56 (0.27 to 0.81) | 5 of 21 | no |
| overflow family, page-overflow-x | 56 / 25, 0.45 | `overflow+lab` | 0.534 | 15 / 10 | 5 / 2 / 2 / 1 | 0.40 (0.12 to 0.77) | 2 of 30 | no |
| text family, text-invisible | 40 / 4, 0.10; 37 / 4, 0.11 | `lab`; `text` | 0.181; 0.558 | 6 / 4; 8 / 5 | 21 / 4 / 8 / 9; 9 / 3 / 4 / 2 | 0.19; 0.33 | 4 of 9; 3 of 9 | no |
| occlusion, styles, leaks, controls, all checks | | none reaches 60% on dev | | | | | | no |

The media hybrid's 27 labelled flags are on 17 sites, 11 with a real flag; the checks alone flag 44 crops on 30 sites
with the same 11. On all natural test elements the hybrid flags 125 (FRR 0.018%, 2.3% of natural pages). The media
checks alone flag 933 (0.13%, 6.8% of pages). With the tie-break error (section 3) the media filter was the `media`
model at 0.537: 24 / 16 / 3 / 5 (0.67), 16 of 21 kept. Run A (no training-only labels): media family 24 / 14 (0.58),
image-broken 17 / 14 (0.82, ships by the numbers, and only one non-bug fewer than the check alone).

### Does v2 beat the rules on real pages?

| family | measured checks (test) | best v2 detector chosen on dev | verdict |
|---|---|---|---|
| all families | 424 flags, 58 real (0.14); 58 of 73 bugs | `any+lab` at frr-0.1%: 68 flags, 38 real (0.56); 38 of 73 | yes on precision (4x), lower recall |
| media | 44, 19 real (0.43); 19 of 21 | hybrid: 27, 19 real (0.70); 19 of 21 | **yes**: same bugs, 17 fewer false reports |
| overflow, responsive | page-overflow-x 56, 25 real (0.45); 24 of 30 | `responsive+lab`: 10, 7 real (0.70); 6 of 30 | higher precision, far lower recall: a complement, not a replacement |
| text, dark (contrast) | 40, 4 real (0.10); 4 of 9 | `text` 21, 4 real (0.19); 4 of 9 | both poor; no |
| occlusion | 248, 9 real (0.04) | `occlusion` 23, 3 real (0.13) | both poor; no |
| leaks | 2, 1 real | `leaks+lab` 15, 8 real (0.53); 1 of 2 | 2 test leaks: too few to judge |
| styles, controls, blank, motion, design, other | no real bug labelled | no real bug found | no |

The recall comparison favours the checks: 800 of the 2,200 crops were picked because a v1 check flagged them, and
111 of the 139 labelled real bugs are among those.

## 5. Blind hand check of flags outside the labelled set

A pure model's flags mostly fall on elements nobody labelled (the "covers" column). `handcheck_v2.py` drew a seeded
sample of each candidate's test flags that are in the viewport, visible and not labelled crops, from the view's
screenshot (desktop at 0.5 scale, phone at 0.75), mixed and shuffled. Each sheet cell showed only a number and the
view, never the source or score. The training agent gave each a verdict. The key (numbers to rows, sources, hosts)
stayed on c20 until the verdicts were in.

| source (test flags outside the labelled set) | natural flags in all | eligible | checked | real | unclear | not | precision | sites (sites with a real flag) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| **media hybrid, `media+lab` at 0.026 (shipped)** | 125 | 54 | 30 | 25 | 2 | 3 | **0.83** | 9 (6) |
| media check findings that filter drops | 808 | 29 | 29 | 1 | 11 | 17 | 0.03 | 11 (1) |
| media hybrid with the tie-break error, `media` at 0.537 | 70 | 46 | 30 | 30 | 0 | 0 | 1.00 | 5 (5) |
| media check findings that filter drops | 863 | 37 | 30 | 2 | 13 | 15 | 0.07 | 13 (2) |
| media checks alone | 933 | 83 | 30 | 18 | 2 | 10 | 0.60 | 13 (4) |
| `media` model at its ship threshold | 117 | 91 | 30 | 10 | 1 | 19 | 0.33 | 15 (4) |
| `media+lab` at its ship threshold | 512 | 248 | 30 | 8 | 1 | 21 | 0.27 | 19 (4) |
| **`responsive+lab` at its ship threshold (shipped)** | 114 | 11 | 11 | 10 | 1 | 0 | **0.91** | 4 (3) |
| `responsive` at its ship threshold | 125 | 15 | 15 | 13 | 1 | 1 | 0.87 | 6 (4) |
| pooled `any` at frr-0.1% | 636 | 387 | 24 | 11 | 8 | 5 | 0.46 | 22 (11) |

Real findings were broken images showing their alt text (many on one page with a row of partner logos, seen in
several views), placeholder image boxes, desktop layouts cut at the right edge of a phone screen, buttons cut at the
screen edge, and builder badges over content. The pure media models' non-bugs were mostly small icons and thumbnails
that load fine. The samples cluster on few sites, so the per-site counts are the more cautious reading. Of all shipped
evidence, the responsive detector's (4 sites in the hand check, 8 in the labelled set) is the thinnest.

## 6. Injected faults: recall at 0.1% and 1% false reports (test)

Recall on fault rows the pixel check saw change at rest (not noisy). Thresholds are set on dev natural elements.

| family | seen fault rows | family model, recall at FRR 0.1% | at FRR 1% | pooled model at 0.1% | at 1% | measured checks of the family | their FRR |
|---|---:|---:|---:|---:|---:|---:|---:|
| blank | 85 | 0.929 | 0.965 | 0.059 | 0.518 | no check | |
| controls | 477 | 0.834 | 0.939 | 0.665 | 0.874 | 0.000 | 0.00% |
| dark | 22 | 0.909 | 1.000 | 0.500 | 0.909 | no check | |
| design | 294 | 0.381 | 0.697 | 0.136 | 0.459 | no check | |
| leaks | 128 | 1.000 | 1.000 | 0.859 | 0.938 | 0.812 | 0.01% |
| media | 208 | 0.962 | 0.995 | 0.615 | 0.803 | 0.034 | 0.13% |
| motion | 151 | 0.894 | 0.980 | 0.391 | 0.762 | no check | |
| occlusion | 376 | 0.971 | 0.997 | 0.896 | 0.942 | 0.000 | 0.25% |
| other | 207 | 0.304 | 0.957 | 0.039 | 0.483 | no check | |
| overflow | 314 | 0.994 | 0.994 | 0.815 | 0.968 | 0.210 | 0.04% |
| responsive | 262 | 0.847 | 0.989 | 0.389 | 0.813 | no check | |
| styles | 414 | 0.324 | 0.657 | 0.126 | 0.360 | 0.058 | 0.05% |
| text | 150 | 0.880 | 0.967 | 0.153 | 0.760 | 0.133 | 0.01% |
| all (pooled) | 3,066 | | | 0.467 (FRR 0.09%, 14.9% of pages) | 0.728 (0.90%, 70.2% of pages) | 0.101 (FRR 0.50%) | |

The shipped scores on injected faults:
- `media+lab`: 0.567 at FRR 0.1% and 0.837 at 1%.
- `responsive+lab`: 0.721 and 0.962.
- The shipped media detector (filter at 0.026): 0.024 of media seen faults, because the measured media checks catch
  only 0.034 of them.
- `responsive+lab` at its ship threshold: 0.011, at FRR 0.016%.

The family models recognise injected faults at near-perfect rates and real bugs far less well; the injected numbers
measure how well a model recognises the recipes. They are reported because the site's tables ask for them, not as
evidence that the model finds bugs on real pages. The faults of the 20 SPREAD recipes are included; the provenance
audit covers clean rows only.

## 7. Calibration (dev) and reliability

Platt scaling (logistic on the score's logit) is fitted on OOF val crops, real against the rest, and is in
`eval-v2.json` (`platt`). Brier score on the labelled test crops, calibrated against the base rate (0.0612): pooled
`any` 0.0484, `any+lab` 0.0447, `lab` 0.0449, `media+lab` 0.0443, `responsive+lab` 0.0518, `media` 0.0555, `text` 0.0615,
`occlusion` 0.0613. The shipped thresholds (0.026 for the media filter, 0.561 for responsive) were chosen on dev
precision, not on a calibrated probability, because the labelled crops are not a random sample of elements.

## 8. Export and cost

`export_v2.py` writes `train/visual-v2.json` ("genclass-visual-2"): the input names (the 113 model inputs), the 14 v1
rule names (the `lab` model also reads their bits, which `src/candidates.mjs` `v1Rules` computes from a view's rows),
three tree models in the v1 compact format (`genclass-gbt-1`), and two detectors:

| detector | kind | score | threshold |
|---|---|---|---:|
| media | check-filter: reported only for a finding of image-broken, media-failed, text-placeholder or image-distorted | sigmoid(-0.458 + 1.015 logit(`media`) + 1.262 logit(`lab`)) | 0.0259 |
| responsive | model | sigmoid(-2.151 + 0.426 logit(`responsive`) + 0.523 logit(`lab`)) | 0.5611 |

| model | trees | internal nodes | JSON | gzip | max difference from LightGBM | LightGBM, one thread |
|---|---:|---:|---:|---:|---:|---:|
| `media` | 36 | 504 | 20,252 B | 6,344 B | 4.0e-8 | 0.7 µs per row |
| `responsive` | 264 | 3,696 | 143,728 B | 41,504 B | 2.1e-7 | 6.2 µs |
| `lab` (113 inputs + 14 rule bits) | 150 | 780 | 33,099 B | 8,926 B | 1.9e-7 | 2.7 µs |
| bundle | | | 199,053 B | 56,850 B | | |

`detect_v2.mjs` is the reference evaluator, with no dependencies beyond `gbt.mjs`. On 21,124 test rows (20,000 random
plus every row a media check flags), every detector's score agrees with Python to 2.3e-7. Both detectors together cost
12.8 µs per element (Node 22.22.0, one thread on c20, 5 passes after a warm-up), about 2.9 ms at the median view (229
rows). The cost is on top of the extractor (p50 18.6 ms per view). `vision/test/detect.test.mjs` checks the evaluator
on a hand-built bundle.

For the scanner: the page runs `src/extract.js`; each row becomes the model inputs (`common.py` `model_inputs`); and
`v1Rules` gives the rule bits for the view. The media detector runs only on elements a media check flagged. The
responsive detector runs on every element and reports at most the elements above 0.561, 0.016% of natural test
elements, on 3.0% of natural test pages.

## 9. Ship decision

| family | ships | detector | why |
|---|---|---|---|
| media | yes | measured media checks filtered by `media+lab` at 0.026 | dev 11 of 17; test 19 of 27 real (0.70) with 19 of 21 bugs found; hand check 25 of 30 (9 sites) |
| responsive | yes, on thin evidence | `responsive+lab` at 0.561 | dev 6 of 10; test 7 of 10 (0.70); hand check 10 of 11 (4 sites) |
| overflow | no: measured check page-overflow-x | | dev threshold gave 5 test flags (2 real) |
| text, dark | no: measured checks | | no threshold at 60% on dev; test precision 0.19 at best |
| occlusion | no: measured checks | | no threshold at 60% on dev |
| leaks | no: measured checks | | no threshold at 60% on dev; 2 labelled test bugs |
| styles, controls, blank, motion, design, other | no: measured checks | | no labelled real bug, none found |

A draft model block for `site/src/data/visual.json` (branch `wave2/site-launch`) is in `visual-model.draft.json`.
It holds measured numbers only; families that did not ship are listed as measured checks.

## 10. Reproduce

On c20 with the v2 training set in `~/vision-out/v2/trainset` and LightGBM's libgomp on the path
(`export LD_LIBRARY_PATH=~/vt-venv/gomp`):

```bash
cd ~/gcl/vision
~/vt-venv/bin/python label/resolve.py --raw ~/vision-out/v2/labels-raw.json --crops ~/vision-out/v2/crawl \
  --set ~/vision-out/v2/trainset --sheets ~/vision-out/v2/sheets --out ~/vision-out/v2/labels.json --public results/v2/labels.json
~/vt-venv/bin/python label/sheets_extra.py --crops ~/vision-out/v2/crawl --views ~/vision-out/v2/trainset/views.jsonl.gz \
  --out ~/vision-out/v2/sheets-train --quota page-overflow-x=120,image-broken=24,text-template-leak=24,image-distorted=48,text-invisible=60,css-var-undefined=12,font-failed=6,click-blocked=6,control-unreachable=48 \
  --sources gbt=36,random=36
~/vt-venv/bin/python label/resolve.py --raw ~/vision-out/v2/labels-extra-raw.json --crops ~/vision-out/v2/crawl \
  --set ~/vision-out/v2/trainset --sheets ~/vision-out/v2/sheets-train --out ~/vision-out/v2/labels-extra.json
cd train
X="--out ~/vision-out/v2/models/v2b --extra ~/vision-out/v2/labels-extra.json"
~/vt-venv/bin/python train_v2.py search --narrow --trials 6 $X   # run A: train_v2.py search --trials 16 --out .../v2
~/vt-venv/bin/python train_v2.py train $X
~/vt-venv/bin/python train_v2.py stack $X
~/vt-venv/bin/python eval_v2.py --models ~/vision-out/v2/models/v2b
~/vt-venv/bin/python handcheck_v2.py sheets --models ~/vision-out/v2/models/v2b --hybrid media --n 30 --seed 23 --out ~/vision-out/v2/handcheck/hc3
~/vt-venv/bin/python export_v2.py && ~/node/bin/node detect_v2.mjs ~/vision-out/v2/export
```

Run times on c20: search 6.5 minutes (run A: 43 minutes for 15 trials, and 14 more for the trial that was stopped),
training of the 14 models 29 minutes, stack 25 s, eval 6 s, export 4 s.

## 11. Limits

- **The labelled test set is a candidate sample.** It holds 1,114 crops, 73 real. It is fair for the checks and the
  hybrids, whose flags it samples. It is not fair for a pure model's own flags, which is why the hand check is part
  of the criterion.
- **The hand checks are small and clustered**: 30, 11 and 24 flags on 9, 4 and 22 sites. They were done by the
  agent that trained the models, blind to source and score, from low-resolution screenshots.
- **The training-only labels came from that same agent.** They are on training hosts only and never touch a
  threshold or an evaluation.
- **Static crawl.** One load per host, at rest. Phone views are the desktop page resized (no mobile emulation).
  Nothing that needs scrolling, hover, focus or time is seen. Faults the pixel check did not see change at rest were
  left out of training.
- **Few labelled bugs per family**: test 21 media, 30 overflow and responsive, 11 occlusion, 9 contrast, 2 leaks.
  The family decisions for occlusion, contrast and leaks rest on very little.
- **The responsive detector's** 70% rests on 10 labelled flags (CI 0.40 to 0.89) and 11 hand-checked flags from 4
  sites. A false-report budget for the scanner should watch it first.
