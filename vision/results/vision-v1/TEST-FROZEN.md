# Vision v1 fresh test set and ship rule (frozen 2026-10-14, before any model was trained)

This file fixes the test set, how it is labelled, how labels are resolved, the metrics and the ship rule of
GenClass Vision v1. It was committed before any Vision v1 model was trained, before any model scored a test crop
and before any test label existed. The test labels will be added (as a digest) in a second commit before the one
evaluation run. Code: `vision/vision_v1/freshtest.py` (design, sheets, resolution), `LABELLING.md` (the labellers'
instructions).

## Why a new test set

The round-2 val and test labels were read while the round-2 detectors were designed, and the 420 extra labels and
the hand checks were made by the agent that trained them (`vision/results/v2/TRAINING.md`, status note). For Vision
v1 every existing labelled crop (round-2 val and test, 2,200 crops; the 420 extra; the hand checks) is training or
dev data only. Dev means the 2,200 round-2 crops: thresholds and model choice are made there. The 420 extra crops
are on training hosts and are not used as labels at all.

## The test set

- **Hosts.** Round-2 *train* hosts that are not near-duplicates, have natural views and have no labelled crop of any
  kind: 5,257 of 5,605. 815 of them (15%, salted SHA-256 of the host, salt `vision-v1-fresh-test`) are held out.
  Vision v1 trains on no element of these hosts. No labeller and no hand check has looked at them. (The round-2
  models were trained on element rows of these hosts, as of every train host; Clef scored their candidate crops for
  the strata below.)
- **Pool.** The crawl's full-resolution candidate crops (`crawl.mjs`: up to 2 v1 rule flags, 2 v1-model picks and 2
  random visible elements per natural view, cut from a viewport PNG with 24 px of context, JPEG quality 90) on 810
  of the held-out hosts: 9,206 crops.
- **On-screen only.** The crawl kept screenshots of the first screen only, so every pool crop is an element at least
  partly inside the 1366 x 768 (desktop) or 390 x 844 (phone) viewport. No claim made from this test set covers
  elements below the fold.
- **Strata**, drawn in this order without replacement (seed 11):

  | stratum | pool | drawn | how |
  |---|---:|---:|---|
  | rules | 603 | 500 | uniform among crops a v1 measured rule flagged |
  | random | 4,206 | 350 | uniform among the crawl's random visible elements no rule flagged |
  | clef-high | 8,253 left | 350 | the highest teacher scores among the rest |
  | clef-low | lower half of the rest | 100 | uniform |

  The teacher score is the sum of the logits of Clef's anyProblem (1 − P(family = none)) under the two prompts of the
  Clef evaluation, `clef-img-p3` and `clef-imgonly-p2`. Clef chose two strata, so Clef's own numbers on this set are
  biased in its favour; the rules and random strata are not chosen by Clef and are reported on their own.
- **Size.** 1,300 crops of 507 hosts: desktop 609, phone 691; light 963, dark 337; AI-builder 915, control 385.
- **Ids.** Test ids and sheet codes are random (`secrets.token_hex`); nothing derives from a host, view, URL or time.
  The manifest (test id, crop digest, stratum, inclusion probability) stays on the data node; no per-crop row is
  committed.
- **Manifest digest** (`freshtest.py digest`: SHA-256 over the lines `test-id image-sha256 stratum inclusion-prob`,
  sorted): `8060381df63215fd9b86c731ff3425d4f8e8e336dcca4d03299dda6393a230f0`.

## Labels

- **Labellers are AI agents** (Claude subagents), not people. Each pass is a separate agent session that sees only
  its own blind sheets and `LABELLING.md`: no Clef answer, no model score, no rule flag, no stratum, no other pass's
  labels.
- **Passes.** Pass A and pass B label all 1,300 crops, each on its own sheets (its own random order, its own random
  cell codes; 9 crops per sheet, 145 sheets). Crops where A and B differ in verdict, or both say real with different
  families, go to pass C (a third, separate agent, on new sheets).
- **Resolution** (`freshtest.py resolve`): the verdict of A and B when they agree; otherwise the majority of A, B and
  C, and unclear when all three differ. The family of a real crop is the family at least two real votes share, else
  "mixed" (real for any-family numbers, never in-family).

## Metrics (one evaluation run, after the model is final)

- **In-family precision**: a flag of a family-f detector counts as real only when the crop is a real bug of family f.
  Unclear counts as not real. Any-family precision (real of any family) is reported next to it. 95% Wilson intervals.
- **Weighted precision**: Horvitz-Thompson over the pool, each crop weighted by 1 / its inclusion probability, so the
  oversampled strata do not inflate it.
- **Ranking**: average precision, precision at recall 0.5, recall at precision 0.6 and 0.8 (`metrics.py`, the Clef
  evaluation's definitions), for the anyProblem score (real of any family against not; unclear left out), overall
  and per stratum; per family with at least 15 in-family real crops (that family's reals against every not).
- **Detectors**: the Vision v1 student (family probabilities, anyProblem); Clef (the teacher: the mean of the two
  prompts' family probabilities, and the logit sum for anyProblem); the v1 measured rules of each family (fixed
  operating point); and each family's rules filtered by the student (a rule flag kept when the student's
  probability of that family reaches a threshold), and by Clef.

## Thresholds (dev only)

For each detector and family f: the lowest threshold at which at least 60% of the dev flags are in-family real bugs
(round-2 labels, unclear counted as not real), with at least 5 dev flags. A family with no such threshold on dev has
no operating point and does not ship.

## Ship rule

A family ships, as a standalone detector or as a filter on its measured rules, only if at its dev threshold on the
fresh test set:

1. it flags at least 10 test crops;
2. at least 60% of its test flags are in-family real bugs (unclear counted as not real); and
3. the weighted in-family precision is at least 60%.

Otherwise it does not ship. Against Clef, per family with at least 15 in-family real test crops: Vision v1 **beats**
Clef when the 95% host-bootstrap interval of the in-family AP difference (student minus Clef, 2,000 resamples) is above
0, **falls short** when it is below 0, and **matches** otherwise.
