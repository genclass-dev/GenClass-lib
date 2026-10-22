# GenClass runtime model: model card

This card describes `@genclass/runtime-model@0.2.0`, the on-device model that
[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) 0.1.0-beta.1 and later load by default to
diagnose stale responses, duplicate requests, inconsistent state and failure storms in web apps. **It ships
`genclass-runtime-r17` 2.0.0-rc4t (training run `r17-v2dT`), with a gain gate and three aggressiveness profiles in
`meta.json`.** It reads the runtime's frozen situation format: it was trained on `situation-v2` data plus the
`situation-v2.3` top-ups (simulated and real), and `@genclass/runtime` 0.1.0-beta.0 and later render
`situation-v2.3`.

The numbers below are copied from
[`training/EVAL.md`](https://github.com/genclass-dev/GenClass-lib/blob/main/training/EVAL.md) and
[`docs/runtime/RESULTS.md`](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md) in the
GenClass-lib repository; those files have the definitions and full tables. Two latency measurements come from
elsewhere and are linked where they are used: the runtime's changelog (WebGPU) and
[`packages/runtime/src/model/README.md`](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/src/model/README.md)
(WASM threads); the app counts come from
[`realapps/README.md`](https://github.com/genclass-dev/GenClass-lib/blob/main/realapps/README.md). The quality
numbers (accuracy, false-intervention rates, recall, detections, calibration) are on held-out data.

## What it is

A typed-decision encoder for `@genclass/runtime`, built like the project's earlier research encoder, GenClass 0.1
([`research/`](https://github.com/genclass-dev/GenClass-lib/tree/main/research)). Older docs call this design
"Jev-style" after Jev, a TypeSafe AI product whose System One request format of typed questions GenClass 0.1
reimplemented; GenClass is not affiliated with or endorsed by TypeSafe AI
([`research/GENCLASS.md`](https://github.com/genclass-dev/GenClass-lib/blob/main/research/GENCLASS.md)).

One forward pass reads a *situation* (the runtime's `app / trigger / facts / in_flight / timeline / state / stats`
text) together with typed questions (choice, noul for yes/no, score). Each question gets calibrated answers, and
options are attention-isolated, so option order cannot change an answer. For every salient trigger the runtime asks
two standing questions:

- `action`: which of the applicable actions to take, each with its description;
- `diagnosis`: what is going on (`expected` / `stale` / `conflict` / `duplicate` / `inconsistent` / `failing` /
  `slow` / `overload` / `unusual` / `transient`).

**Gain gate.** The action labels of `r17-v2dT` are `softmax(gain / τ)` with τ = 1, where gain is the expected
counterfactual cost saved by each action over doing nothing. The runtime acts only when the model's expected gain
of the best permitted non-passive action clears the margin for that tier and trigger (`meta.json` `gate`,
`kind: "gain"`), **and** the top diagnosis is not `expected`. It reports a detection when the top diagnosis is not
`expected` and its probability is at least `gate.report`. `gate.profiles` holds the three profiles; the top-level
`gate` is `balanced`.

| | |
|---|---|
| backbone | ettin-encoder-17m (d 256, 7 layers: global attention in layers 1, 4, 7, 64-token sliding windows in the others) |
| parameters | 8.8M: 8.1M encoder + 0.7M heads after vocabulary pruning |
| vocabulary | 16,364 tokens (the first 16,000 merges of the ettin tokenizer, plus markers `[Q] [O] [L] [T] [F]` = ids 16359–16363) |
| positions | `max_len` 2,048 (state plus the longest question branch), `max_total` 8,192 |
| `genclass-runtime-r17-q8.onnx` | 10.16 MB (10,160,186 bytes): MatMulNBits 8-bit (block 16) and int8 row-wise token embeddings, fp16-free. For WASM, and WebGPU without `shader-f16` |
| `genclass-runtime-r17-fp16.onnx` | 13.57 MB (13,569,879 bytes): fp16 weights and int8 embeddings. Needs WebGPU `shader-f16` |
| graph | inputs `input_ids, position_ids, q_group, i_group, choice_q, choice_items, score_q, score_items, noul_q, noul_t, noul_f`; outputs `choice_logits, score_logits, noul_logits` |
| parity | onnxruntime-web q8 vs PyTorch: 223/223 decisions (block 32 lost parity; block 16 restored it) |

**Latency** (onnxruntime-web 1.30, WASM, 1 thread, q8; a least-squares fit over the validation requests, run in
Node on the training VM, not in a browser, so these are estimates at those lengths, not single measurements;
[`training/ortweb/validate.mjs`](https://github.com/genclass-dev/GenClass-lib/blob/main/training/ortweb/validate.mjs),
[RESULTS.md §2](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#2-r17-vs-r32-choosing-the-shipping-model)):
about 182, 330 and 599 ms per forward pass at 500, 780 and 1,170 sequence tokens. On WebGPU, on one Apple GPU with
this model, a ~430-token warm-up pass took 49–74 ms and the first real decision 137 ms
([runtime 0.2.2 changelog](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/CHANGELOG.md#022-2026-10-13));
no systematic WebGPU latency benchmark has been published. Four WASM threads on a crossOriginIsolated page were
about 3× faster than one in headless Chromium in an earlier measurement with GenClass 0.1's 32M-parameter model
(271–360 ms against 837–981 ms at 780 sequence tokens;
[`packages/runtime/src/model/README.md`](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/src/model/README.md));
this has not been re-measured for 0.2.0. Normal traffic makes no model calls: the runtime asks only about salient
situations.

## Results on held-out data

### Shipped profiles (0.2.0, `r17-v2dT`)

Gates were fitted on the outputs of the shipped q8 file, on dev data (simulated apps, on-policy rows from the
shipping gate, and a real-app certification set counted per trajectory), as the lowest margin per tier and trigger
whose cluster-robust 95% Wilson upper bound meets the profile's limits, then verified on held-out test. FIR is the
false-intervention rate: the share of cases where doing nothing was best but the gate fired anyway. Harm is the
share of decisions whose action made the outcome worse; recall is on clear cases (simulated) and on actionable
real-app cases; gain is the share of the available counterfactual improvement captured; detected is the share of
real problems on held-out real apps that were reported with the right diagnosis (stale on the `situation-v2.3`
slice; on `situation-v2`: 14% / 21% / 40%).

| profile | limits (guard FIR / harm; heal FIR / harm) | guard FIR / harm | guard recall (clear / real) | guard gain | heal FIR / harm | heal recall (clear / real) | heal gain | report | detected (duplicate / stale / broken) |
|---|---|---|---|---|---|---|---|---|---|
| `cautious` | 0.1 / 0.2%; 0.5 / 1% | 0.005% / 0.007% | 2.4% / 1.4% | 3.1% | 0.26% / 0.06% | 3.7% / 3.8% | 3.2% | 0.95 | 72% / 28% / 0% |
| **`balanced`** (default) | 0.3 / 0.3%; 1 / 1% | 0.13% / 0.03% | 7.8% / 7.5% | 6.7% | 0.59% / 0.11% | 7.1% / 10.4% | 5.7% | 0.90 | 75% / 30% / 6% |
| `eager` | 1 / 1%; 3 / 3% | 0.54% / 0.11% | 14.2% / 21.0% | 12.5% | 1.84% / 0.29% | 17.1% / 24.2% | 14.2% | 0.70 | 77% / 45% / 13% |

FIR and harm are on simulated apps; on held-out real apps FIR was 0.00% for every profile. Every profile meets its
limits on held-out test. The project targets are guard FIR ≤ 0.1% and heal FIR ≤ 0.5%: `cautious` stays under
both, `balanced` is slightly over both, `eager` is well over.

**Gain margins** (`meta.json` `gate.profiles`; a trigger not listed uses the tier default; `mutation` never acts
in `cautious`):

| profile | guard margin: default (delivery / mutation / request) | heal margin: default (failure / inconsistency / request / stall / transition) | `report` |
|---|---|---|---|
| `cautious` | 6.0 (5.0 / never / 5.0) | 5.0 (8.0 / 3.0 / 2.5 / 1.5 / 0.75) | 0.95 |
| `balanced` | 5.0 (4.0 / 6.0 / 4.0) | 4.0 (8.0 / 2.0 / 1.5 / 1.25 / 0.5) | 0.90 |
| `eager` | 3.0 (3.0 / 4.0 / 3.0) | 2.5 (5.0 / 0.75 / 0.25 / 1.0 / 0.0) | 0.70 |

**Accuracy** on the held-out test sets (`sim2e` simulated apps, `sim3e` the `situation-v2.3` slice, `real2e` /
`real3e` real apps in Chromium), action / diagnosis: `sim2e` 73.9% / 85.4%, `sim3e` 70.7% / 84.2%, `real2e`
77.8% / 85.5%, `real3e` 71.9% / 86.4%. Action accuracy is not comparable with 0.1.0 below: `r17-v2dT`'s action
labels are gain distributions, not argmax labels.

**Calibration.** ECE has not yet been measured for 0.2.0. For `r17-v2b` (0.1.0) it was 0.021–0.023 (action).

### Previous model (0.1.0, `r17-v2b`, fixed-threshold gate)

The false-intervention rates here use the fixed 0.9 / 0.8 gates.

| set | action | diagnosis | guard FIR @0.9 | heal FIR @0.8 | ECE (action) |
|---|---|---|---|---|---|
| sim2e | 77.8% | 84.2% | 0.01% | 0.50% | 0.023 |
| sim2f | 77.0% | 80.6% | 0.00% | 0.70% | 0.022 |
| real2e | 80.0% | 83.6% | 0.00% | 0.31% | 0.021 |

**Observe-mode false detections.** For 0.2.0 the gate fit held them to at most 1% / 2% / 5% of clean real-app
decisions and 2% / 3% / 6% of simulated `expected` rows for `cautious` / `balanced` / `eager`, and every profile met
those limits on held-out test; the exact rates are not published. 0.2.0's detection rates are in the profile table
above. From `@genclass/runtime` 0.3.0, observe by default also records *possible* detections, whose probability
reaches the `eager` report value (0.70) but not the profile's report gate, on `console.debug`, in the devtools and in
telemetry; at `balanced`, the *likely* detections (those at the report gate) and the possible ones together are then
the `eager` row's detections (duplicate / stale / broken 77% / 45% / 13%, false detections held to at most 5% / 6%). Neither tier has been measured end to end on 0.3.0, and the share of possible
detections that are false is not measured
([RESULTS.md §11](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#11-observe-mode-detection-in-030-the-possible-tier-and-deferred-situations)).
For 0.1.0 (`gate.report` 0.85): 0.36% on clean or benign real-app traffic; 3.78% of held-out real-app
decisions whose correct diagnosis was `expected` (305 / 8,079; on the `real2e` slice, 240 of its 303 false
detections came from one held-out app, flagged as `stale` on one field, and without that app the slice is 1.05%);
1.1% / 1.7% of simulated `expected` rows (`sim2e` / `sim2f`), but 3.1% on the on-policy round b test set, over the
2% limit ([RESULTS.md §1](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#1-model-stages-compared-held-out-simulated-apps)).
It detected about 76% of duplicate submits and 28% of stale overwrites on real apps never trained on.

**Reading.** The model rarely acts, and misses most problems. In guard mode at `balanced` it intervenes in 7.8% of
the clear simulated cases where acting would help (FIR 0.13%). Precision among its actions was not measured for
0.2.0 (on-policy round b, `r17-v2b` with its data-derived gates: 11% of its actions were false). Its main value
today is observe mode: plain-English detections with the evidence. Recall is the open problem: a 150M teacher was
trained and scored below `r17-v2b` on every held-out set, so distillation was skipped
([RESULTS.md §1](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#1-model-stages-compared-held-out-simulated-apps)).

## Training data and licence

Apache-2.0. Initialised from `jhu-clsp/ettin-encoder-17m` (MIT). It was trained only on data generated for this
project:

- **Curriculum:** about 1.9M programmatic rows (`cur1` to `cur4`) of runtime situations with exact labels; stage 1
  trained on 1.2M of them, and later rounds replay a share, with a `situation-v2` curriculum (`cur5`). They cover
  timeline/causality/version/identity/streak/baseline/invariant/transition/HTTP/JS-error primitives and
  described-option decisions.
- **SIM:** the project's deterministic simulator of combinator-built apps (46 features, 115 domains): 10.4M
  `situation-v2` gold rows, of which 7.56M are the training split (318k dev and 2.55M test held out), plus a 2.1M
  `situation-v2.3` top-up. Labels come from counterfactual outcomes: each candidate action is replayed and its cost
  measured.
- **REAL:** traces from 158 web apps run in headless Chromium with the real runtime (128 apps for the
  `situation-v2` rows, all 158 for the `situation-v2.3` top-up; `realapps/README.md`), 837,623 rows: 616,437
  `situation-v2` and 221,186 `situation-v2.3`, labelled the same counterfactual way. 144 apps were written for the
  corpus. 14 are MIT-licensed open-source RealWorld front-ends, listed in
  [`realapps/corpus/LICENSES.md`](https://github.com/genclass-dev/GenClass-lib/blob/main/realapps/corpus/LICENSES.md);
  their code is not part of this model, only traces of running them. Every row of the real-app evaluation sets was
  excluded from training.
- **On-policy rows:** 1,248,131 situations from `r17-v2a` acting in the simulator (round a, DAgger-style; of them
  448k at the shipping gate and 672k at an exploratory gate of 0.5, the rest not broken down in RESULTS.md §6),
  labelled the same way. Round b (1,094,953 rows, from `r17-v2b`) was not trained on. The shipping-gate rows of
  rounds a and b were used to fit and test the gates.
- **Replay:** GenClass 0.1's synthetic generic data.

Row counts are from [RESULTS.md §6](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#6-data-volume)
and count every row generated, held-out dev and test splits included (splits are per trajectory). The 51M unlabeled
simulated rows listed there were generated for teacher labelling and not used, since distillation was skipped.

No benchmark, scraped or third-party dataset was used, and no weights from other GenClass experiments.

## Intended use and limits

- It decides generic runtime actions and diagnoses from facts the runtime observed:
  - apply / discard / defer
  - send / coalesce / delay / block / serve_cached
  - deliver / retry / serve_cached
  - wait / hedge / serve_cached
  - ignore / rollback / resync

  It never sees your source code.
- **Precision first.** "Do nothing" is the best answer for most decisions in the project's data, including
  salient-looking benign cases: older writers in between, deliberate repeats, polling, typing bursts and explained
  relation changes. It was about 55% of curriculum rows and 70–96% of simulated rows in the stage-1 measurements
  (`training/EVAL.md`), 50% to 100% per trigger in the earlier `situation-v1` real-app pilots
  (`realapps/README.md`), and 75% of decision rows in `sim2e` (9,464 of 12,696) and 74% in `sim2f` (8,703 of
  11,756), the held-out `situation-v2` simulated test sets (the guard FIR denominators in `training/EVAL.md`). The
  share in the training split has not been published. Please report false interventions and false detections from
  your app ([GitHub Issues](https://github.com/genclass-dev/GenClass-lib/issues)).
- Recall on actionable cases is low (see above). The runtime fails open: while the model is loading, after an error,
  or when it answers too late, the app runs unchanged.
- Developer `ask` / `decide` questions work for short factual questions about the current situation. It is a small
  encoder (8.8M parameters), not a general reasoner.
