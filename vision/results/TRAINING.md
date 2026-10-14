# Visual-bug classifier: training and evaluation, 2026-10-14

Data: the training set from the 2026-10-14 crawl (`vision/results/README.md`; 3,000 AI-builder and 600 control
homepages, 35,074 injected faults in 13 families). Code: `vision/train/` (`common.py`, `train_gbt.py`,
`train_mlp.py`, `evaluate.py`, `export.py`, `crops.py`, `gbt.mjs`). Everything ran on c20 (F80ads_v7, 80 vCPU),
00:35 to 00:52 UTC on 2026-10-14 (c20 started 00:29, deallocated 00:55). Reports, in `vision/results/train/`:
`eval.json` (every number below), `train-*.json`, `export-*.json`, `handcheck/` (the flags that were looked at,
each with a verdict) and the exported small model `gbt-small.json`.

## Answer first

- On injected faults the learned trees beat the measured thresholds by a wide margin. With the threshold set on
  dev to the thresholds' own false-report rate (test: 0.48% of natural elements for `gbt`, 0.53% for the
  thresholds), the gradient-boosted trees (`gbt`) flag 56.2% of fault rows against 7.1%, 78.7% against 6.7% of the
  faults the pixel check saw, and at least one fault row on 84.4% of injected pages against 12.4%, with a similar
  share of clean pages flagged (29.8% against 26.7%).
- On real pages the learned model does not beat the thresholds. All 99 in-viewport `gbt` flags on natural test
  pages at a 0.1% element false-report rate were checked by eye: 1 real bug, 3 unclear, 95 correct elements. A
  sample of 40 threshold flags held 3 real bugs and 3 unclear ones. Both rates are low; the model's is lower.
- Why: the model's strongest inputs are the tag, the box area and the device. That is where the recipes put
  their labels, not what a broken element looks like, so most of its flags on clean pages are ordinary desktop
  buttons and links. The injected-fault recall above measures how well it recognises the recipes.
- Do not ship the learned model as a check. The measured checks stay the path; section 9 lists what would have to
  change before a learned model is worth another run.

## 1. Data and splits

Splits are by host after near-duplicate removal (`vision/src/build_set.mjs`: sha1 of seed and the cluster's
representative host). `val` is the dev split: operating points and model choice use it; test is only measured.

| split | hosts | natural rows (clean views) | clean views | clean rows of injected views (sampled) | control rows | fault rows | fault rows the pixel check saw | injected views with fault rows |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| train | 2,804 | 2,435,257 | | 796,232 | 1,815 | 54,288 | | |
| dev (`val`) | 351 | 282,352 | 808 | 101,978 | 238 | 7,233 | 1,752 | 2,244 |
| test | 305 | 262,293 | 708 | 88,468 | 212 | 5,994 | 1,377 | 2,014 |

The natural test slice is the 262,293 element rows of the 708 clean views (desktop light, phone light and, for a
seeded third of hosts, phone dark) of the 305 test hosts. Nothing was injected into these views.

**False-report rate (FRR)** in this file is the share of natural elements a check flags. Some natural elements are
real bugs, so FRR counts them as false reports; the hand checks in section 6 say how many are real. **Page FRR**
is the share of clean views with at least one flag. **Recall** is the share of fault rows flagged; **page recall**
is the share of injected views with fault rows where at least one fault row is flagged. Page-level recipes that
label the view and no element (`attribute: page`) are not in the element recall; they are in section 4.

## 2. Models

| model | what | training rows (train split) | time on c20 |
|---|---|---|---|
| `rules` | the measured thresholds of `docs/runtime/VISUAL.md` (branch `wave2/visual`) section 3, as far as one element row can express them: `common.rules` | none | |
| `rules-core` | `rules` without the static stand-ins for the three interaction checks (control-unreachable, click-blocked, dialog-covered) | none | |
| `gbt` | LightGBM 4.7.0, binary, 63 leaves, learning rate 0.05, early stop on dev average precision; 114 inputs | 1,652,335 (54,288 faults; 1,815 controls at weight 3; 796,232 clean; 800,000 natural rows with no natural-signal bit, seeded) | 18 s, 671 trees |
| `gbt-small` | the same with 15 leaves, depth 6, learning rate 0.1, at most 600 trees (the shipping-size candidate) | the same | 8 s, 600 trees (the cap) |
| `mlp` | PyTorch 2.14.1 CPU: signed log inputs, an 8-wide embedding per categorical column, 256 and 128 ReLU units, 6 epochs, best dev epoch kept; 89,897 parameters | the same | 44 s |
| `gbt-seen` | `gbt` trained only on fault rows the pixel check saw change; other fault rows left out | 1,611,280 (13,233 faults) | 25 s, 950 trees |

Inputs: the 112 extractor columns minus pRound, pVw, pVh and pDark (they record how a view was made), plus the box
relative to the viewport (x/vw, right/vw, y/vh, bottom/vh, w/vw, area/(vw x vh)). Natural rows that a measured
signal marks (broken image, leak pattern, low contrast, placeholder image, undefined var()) are left out of the
training negatives because some are real bugs; they stay in every evaluation.

The rules, with the VISUAL.md thresholds:

| rule | condition on one element row |
|---|---|
| image-broken | `img`, complete, not loaded, visible, at least 16 x 16 |
| media-failed | `video` with error code 2, 3 or 4, at least 48 x 48 |
| text-invisible | own text, visible, in the viewport, font at least 6 px, contrast under 1.5:1 on a solid background; no gradient text, text-fill colour, text-shadow, animation or disabled state; when the paint stack was read it must agree |
| text-template-leak | a leak pattern in visible own text |
| text-placeholder | `img` from a placeholder-image host |
| css-var-undefined | an undefined `var()` (or a colour invalid after substitution) and own text under 3:1 on a solid background |
| image-distorted | loaded raster, object-fit fill, distortion over 0.05, more than 2 px off on the smaller side, both sides at least 48 px |
| page-overflow-x | the page scrolls sideways (overflow-x not hidden or clip on html and body), the box is past the right edge or left of 0, no clipping ancestor, not fixed; the 3 shallowest per view |
| font-failed | visible text in the viewport whose first family failed to load |
| pointer-events-leak | `pointer-events: none` on body or html |
| scroll-lock-stuck | body or html with overflow-y hidden or clip and more than 100 px cut off |
| click-blocked (static stand-in) | transparent, textless, not interactive, at least 30% of the viewport, absolute or fixed, wins at least 3 of its 5 hit probes |
| control-unreachable (static stand-in) | visible interactive element at least half in the viewport, all 5 hit probes land on another element |
| dialog-covered (static stand-in) | visible dialog with at least 3 of 5 probes on another element |

The runtime runs the last three only after a user action and with conditions a row cannot express (the cover is
fixed or sticky, holds no focusable element, is not a dialog). Their stand-ins here flag elements under consent
banners and modal layers, which is why `rules-core` is listed. Checks only the browser reports (stylesheet-failed,
csp-blocked, layout-shift, image-css-broken) have no element row and are left out.

Model choice on dev (average precision, fault rows against natural rows): `gbt` 0.672, `gbt-small` 0.655, `mlp`
0.582. `gbt` is the best model. (The all-natural-rows variant, 3,241,540 training rows, reached the same dev
average precision, 0.6470 against 0.6469, and is not reported further.)

## 3. Operating points

Each threshold is chosen on dev and applied unchanged to test:

- `frr-0.1%` and `frr-1%`: 0.1% and 1% of dev natural elements flagged;
- `match-rules`: the dev natural-element FRR of `rules` (0.52%);
- `page-5%`: 5% of dev clean pages flagged.

`rules` and `rules-core` have one fixed operating point.

## 4. Results on test

Test split, 305 hosts. FRR columns first; every recall in the row is at that FRR.

| model | operating point (dev) | threshold | natural elements flagged (FRR) | clean pages flagged | recall, all fault rows | recall, pixel-seen fault rows | page recall | control rows flagged | clean rows of injected views flagged |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| rules | fixed | | 0.53% (1,389) | 26.7% | 0.071 | 0.067 | 0.124 | 4.7% | 0.83% |
| rules-core | fixed | | 0.34% (883) | 17.9% | 0.051 | 0.049 | 0.095 | 4.7% | 0.61% |
| gbt | page-5% | 0.626 | 0.07% (175) | 6.4% | 0.415 | 0.683 | 0.743 | 3.3% | 0.11% |
| gbt | frr-0.1% | 0.501 | 0.11% (288) | 10.6% | 0.460 | 0.713 | 0.787 | 7.1% | 0.22% |
| gbt | match-rules | 0.262 | 0.48% (1,250) | 29.8% | 0.562 | 0.787 | 0.844 | 13.2% | 0.84% |
| gbt | frr-1% | 0.191 | 0.95% (2,504) | 40.7% | 0.618 | 0.829 | 0.870 | 15.6% | 1.50% |
| gbt-small | frr-0.1% | 0.504 | 0.12% (315) | 10.9% | 0.420 | 0.690 | 0.744 | 4.2% | 0.21% |
| gbt-small | match-rules | 0.280 | 0.47% (1,232) | 27.8% | 0.549 | 0.771 | 0.820 | 11.8% | 0.76% |
| gbt-small | frr-1% | 0.208 | 0.95% (2,504) | 40.5% | 0.607 | 0.813 | 0.850 | 15.6% | 1.45% |
| mlp | frr-0.1% | 0.606 | 0.15% (395) | 13.1% | 0.370 | 0.643 | 0.702 | 1.9% | 0.20% |
| mlp | frr-1% | 0.202 | 1.06% (2,777) | 44.4% | 0.533 | 0.747 | 0.813 | 11.3% | 1.45% |
| gbt-seen | frr-0.1% | 0.142 | 0.09% (239) | 18.5% | 0.261 | 0.786 | 0.588 | 7.6% | 0.26% |
| gbt-seen | frr-1% | 0.019 | 0.87% (2,280) | 49.3% | 0.342 | 0.914 | 0.657 | 16.0% | 1.82% |

Test average precision and ROC AUC, fault rows against natural rows: `gbt` 0.707 and 0.980, `gbt-small` 0.667 and
0.979, `mlp` 0.609 and 0.967, `gbt-seen` 0.388 and 0.835 (all fault rows counted as positives).

Recall per family on test. Header: model, operating point, and its test FRR on natural elements / share of clean
pages flagged. Cells: recall on all fault rows of the family / on those the pixel check saw.

| family | fault rows (seen) | rules, fixed: 0.53% / 26.7% | gbt, frr-0.1%: 0.11% / 10.6% | gbt, frr-1%: 0.95% / 40.7% | gbt-small, frr-0.1%: 0.12% / 10.9% | gbt-seen, frr-0.1%: 0.09% / 18.5% |
|---|---:|---:|---:|---:|---:|---:|
| blank | 181 (69) | 0.000 / 0.000 | 0.735 / 1.000 | 0.856 / 1.000 | 0.691 / 0.986 | 0.702 / 1.000 |
| controls | 1,704 (177) | 0.043 / 0.062 | 0.316 / 0.678 | 0.430 / 0.791 | 0.291 / 0.616 | 0.107 / 0.723 |
| dark | 173 (40) | 0.000 / 0.000 | 0.942 / 1.000 | 0.965 / 1.000 | 0.908 / 0.975 | 0.266 / 1.000 |
| design | 356 (132) | 0.006 / 0.008 | 0.199 / 0.311 | 0.334 / 0.538 | 0.169 / 0.258 | 0.253 / 0.523 |
| leaks | 223 (62) | 0.399 / 0.500 | 0.735 / 0.968 | 0.933 / 1.000 | 0.673 / 0.968 | 0.417 / 1.000 |
| media | 242 (92) | 0.153 / 0.076 | 0.777 / 0.848 | 0.884 / 0.891 | 0.707 / 0.783 | 0.426 / 0.870 |
| motion | 262 (83) | 0.012 / 0.000 | 0.889 / 0.916 | 0.928 / 0.940 | 0.821 / 0.904 | 0.439 / 0.940 |
| occlusion | 237 (160) | 0.017 / 0.013 | 0.852 / 0.975 | 0.861 / 0.975 | 0.848 / 0.969 | 0.755 / 0.975 |
| other | 736 (112) | 0.105 / 0.054 | 0.251 / 0.375 | 0.433 / 0.571 | 0.209 / 0.348 | 0.151 / 0.464 |
| overflow | 344 (124) | 0.218 / 0.097 | 0.901 / 0.984 | 0.939 / 0.992 | 0.878 / 0.984 | 0.483 / 0.984 |
| responsive | 167 (66) | 0.042 / 0.030 | 0.725 / 0.924 | 0.850 / 0.970 | 0.641 / 0.864 | 0.617 / 0.939 |
| styles | 1,114 (187) | 0.043 / 0.070 | 0.292 / 0.476 | 0.612 / 0.706 | 0.235 / 0.423 | 0.168 / 0.551 |
| text | 280 (88) | 0.036 / 0.102 | 0.504 / 0.466 | 0.786 / 0.852 | 0.479 / 0.614 | 0.279 / 0.852 |

The rules only cover what their checks look for: most families have no rule (dark mode, motion, design, blank as
an element), and text-invisible requires the text to be in the viewport. A recall near 1.0 for families such as
dark or blank is a warning sign, not a strength: those recipes leave inline styles and attributes on the element
that the model can read.

Page recall per family (test injected views with fault rows of the family; rules at 26.7% clean pages flagged,
`gbt` at 10.6% and 40.7%):

| family | pages | rules | gbt, frr-0.1% | gbt, frr-1% |
|---|---:|---:|---:|---:|
| blank | 179 | 0.000 | 0.737 | 0.855 |
| controls | 225 | 0.107 | 0.569 | 0.747 |
| dark | 151 | 0.000 | 0.947 | 0.960 |
| design | 182 | 0.011 | 0.291 | 0.423 |
| leaks | 160 | 0.406 | 0.869 | 0.975 |
| media | 240 | 0.146 | 0.779 | 0.883 |
| motion | 177 | 0.017 | 0.915 | 0.966 |
| occlusion | 237 | 0.017 | 0.852 | 0.861 |
| other | 179 | 0.056 | 0.581 | 0.765 |
| overflow | 318 | 0.236 | 0.918 | 0.950 |
| responsive | 145 | 0.048 | 0.766 | 0.862 |
| styles | 182 | 0.121 | 0.577 | 0.764 |
| text | 141 | 0.071 | 0.560 | 0.787 |

Page facts with no element (test): the sideways-scroll fact holds on 48 of 708 clean pages and on 93 of 756
injected views with page-level labels; page-blank on 3 and 59; viewport-meta-missing on 0 and 0.

## 5. Where the false reports land (test natural slice)

Clean pages flagged, by group and view:

| group / view | pages | rules, fixed | gbt, frr-0.1% | gbt, page-5% |
|---|---:|---:|---:|---:|
| AI-builder desktop light | 249 | 16.5% | 14.1% | 7.2% |
| AI-builder phone light | 251 | 22.7% | 2.4% | 2.0% |
| AI-builder phone dark | 87 | 29.9% | 1.1% | 0.0% |
| control desktop light | 51 | 51.0% | 51.0% | 31.4% |
| control phone light | 52 | 57.7% | 9.6% | 7.7% |
| control phone dark | 18 | 50.0% | 11.1% | 11.1% |

`gbt` flags concentrate on desktop views; device (pDesktop) is its third-strongest input by gain, after the tag
and the box area.

Natural elements flagged per rule (test): control-unreachable 502, image-broken 274, text-template-leak 231,
css-var-undefined 217, page-overflow-x 79, image-distorted 60, text-invisible 22, click-blocked 4, media-failed 2,
the rest 0.

## 6. Hand check on the natural slice

The crawl saved one downscaled viewport screenshot per clean view (desktop at 0.5, phone at 0.75), so only flags
whose box is at least partly in the viewport can be checked. `vision/train/crops.py` drew each flagged box on its
screenshot; each crop was looked at and marked real (a visitor would see something broken: unreadable, covered,
missing, blank), unclear (cannot tell from the crop, or may be intended) or not a bug.

| flags | flagged on test natural pages | in the viewport | checked | real | unclear | not a bug | confirmed-real rate |
|---|---:|---:|---:|---:|---:|---:|---:|
| `gbt`, frr-0.1% (0.11% FRR, 10.6% of pages) | 288 on 75 pages | 99 | 99 (all) | 1 | 3 | 95 | 1.0% (4.0% with unclear) |
| `gbt-seen`, frr-0.1% (0.09% FRR, 18.5% of pages) | 239 on 131 pages | 239 | 40 (seeded sample) | 1 | 1 | 38 | 2.5% (5.0%) |
| `rules`, fixed (0.53% FRR, 26.7% of pages) | 1,389 on 189 pages | 642 | 40 (seeded sample) | 3 | 3 | 34 | 7.5% (15%) |

What was found:

- `gbt`: 74 of the 99 flags are buttons and 92 are on desktop views; most are navigation links, call-to-action
  buttons, form controls, carousel arrows and visually hidden elements. The one real bug is a floating chat button
  half covered by the "Edit with Lovable" badge.
- `gbt-seen`: the one real bug is a phone page whose 12,916 px tall section stays at opacity 0, leaving the page
  blank below the header (a scroll-reveal that cannot fire for an element that tall).
- `rules`: an invisible 26-character paragraph in a white card (text-invisible), floating pill links over a hero
  heading on a phone (control-unreachable), and broken images showing their alt text (image-broken). 18 of the 34
  non-bugs are controls under a consent banner or modal layer, flagged by the control-unreachable stand-in; the
  runtime check excludes those covers.

With so few real bugs among the flags, the natural FRR in section 4 is close to the true false-report rate, not a
loose upper bound.

## 7. Export and cost

| model | format | size | gzip | trees / internal nodes | max difference from LightGBM | per element |
|---|---|---:|---:|---|---:|---:|
| gbt-small | compact JSON (`vision/results/train/gbt-small.json`) | 338,693 B | 95,346 B | 600 / 8,398 | 3.3e-7 | 25.6 us in `vision/train/gbt.mjs` |
| gbt-small | ONNX (opset 15, onnxmltools 1.16.0) | 987,275 B | | | 5.3e-7 | 21.9 us one row per call, 10.8 us batched |
| gbt | compact JSON | 1,639,814 B | 482,640 B | 671 / 41,602 | 2.5e-7 (Python), 3.3e-7 (JS) | 65.8 us in `vision/train/gbt.mjs` |
| gbt | ONNX | 4,016,064 B | | | 3.3e-5 | 44.9 us one row per call, 20.3 us batched |

Timing: c20, one thread; JS on Node 22.22.0 over 20,000 test rows, 5 passes after a warm-up; ONNX on onnxruntime
1.31.0. At the median view (246 rows) `gbt-small` costs about 6 ms and `gbt` about 16 ms, on top of the extractor's
21 ms (`vision/results/README.md`). The `gbt` JSON and both ONNX files stay on c20 in `~/vision-out/export`.

The compact format (`genclass-gbt-1`, described in `vision/train/export.py`) is a flat array of 4-tuples per tree:
numeric splits go left on `x <= t` with LightGBM's double threshold; categorical splits store the input as
`-1 - index` and go left when the value is a whole number in the listed set. `vision/test/gbt.test.mjs` checks the
evaluator on a hand-built model.

## 8. Reproduce

On a claimed node with the training set in `~/vision-out/trainset`:

```bash
python3 -m venv --without-pip ~/vt-venv
~/jev/.venv/bin/pip --python ~/vt-venv/bin/python install numpy scikit-learn lightgbm xgboost onnx onnxruntime onnxmltools skl2onnx pillow
mkdir -p ~/vt-venv/gomp && ln -sf ~/vt-venv/lib/python3.12/site-packages/scikit_learn.libs/libgomp-*.so.1.0.0 ~/vt-venv/gomp/libgomp.so.1
export LD_LIBRARY_PATH=~/vt-venv/gomp   # LightGBM needs libgomp; the node has none outside the wheels
cd vision/train
~/vt-venv/bin/python train_gbt.py                       # gbt and gbt-small
~/vt-venv/bin/python train_gbt.py --only gbt --pos seen # gbt-seen
~/jev/.venv/bin/python train_mlp.py                      # needs torch
~/vt-venv/bin/python evaluate.py                         # eval.json
~/vt-venv/bin/python export.py --model ~/vision-out/models/model-gbt-small.txt
~/node/bin/node gbt.mjs ~/vision-out/export/gbt-small.json ~/vision-out/export/sample-X-gbt-small.f32 ~/vision-out/export/sample-p-gbt-small.f64
~/vt-venv/bin/python crops.py --model gbt --op frr-0.1% --n 100
```

## 9. What would have to change

1. Labels that a static row can see. Only 1,377 of the 5,994 test fault rows (23%) changed pixels in the pixel
   check; the rest are unseen at rest or outside the viewport (focus styles, hover states, content below the
   fold), and families such as controls and styles mark many elements whose rest-state style hardly changes.
   Training only on pixel-seen faults (`gbt-seen`) raised recall on them to 0.786 at a 0.1% FRR, but its natural
   flags were no more often real (1 of 40).
2. Negatives matched to the positives. The model separates faults by tag, size and device because the recipes
   choose their targets that way. Natural elements of the same tag, role and size band, weighted to the fault
   distribution, would take that shortcut away.
3. Recipe traces. Several recipes set inline styles or attributes a real bug would not have; dark and blank reach
   recall near 1.0 for that reason. The extractor could ignore inline styles the recipe wrote, or the recipes could
   write through a stylesheet.
4. A real-bug test set. The three hand checks found 5 real bugs and 7 unclear cases in 179 crops (one unclear
   element is in two samples). Labelling a few
   hundred natural flags from both the rules and the model would give a test that injected data cannot fake.
