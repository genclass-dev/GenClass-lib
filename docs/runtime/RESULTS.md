# GenClass Runtime: results, comparisons and training log

Updated 2026-10-08. All numbers are measured on held-out data. Every recall or fix rate is reported next to its
false-intervention rate (FIR): the share of cases where doing nothing was best but the gate fired anyway. The raw
reports are in `training/EVAL.md`, `sim/SEPARABILITY.md`, `realapps/README.md` and
`demos/results.md`.

## 1. Model stages compared (held-out simulated apps)

| Stage | Data | Diagnosis | Action | Guard FIR | Heal FIR | Recall on clear stale/duplicate cases |
|---|---|---|---|---|---|---|
| GenClass 0.1 (no runtime training) | none | 8.0% | 37.6% | ~0% | 0.0–0.33% | ~0% |
| Stage 1: curriculum only, R17 (tested on simulated apps) | 1.2M curriculum rows | 44% | 48% | 9.7% | 18.4% | n/a (over-intervenes) |
| Stage 2 pilot, R17 | 224k pre-freeze sim rows, mushy labels | 91.1% | 78.3% | 0.00% | 0.08% | ~1% |
| **Final round 1, R17** (format v1) | 448k sim rows (phase A) | **90.5%** | **81.9%** | **0.05%** | **0.24%** | **7.7%** |
| Final round 1, R32 (format v1) | same | 89.7% | 81.8% | 0.05% | 0.22% | 5.9% |
| **r17-v2a** (format v2, first round) | 2B tokens of v2 sim gold + v2 curriculum | 84.4% | 77.9% | **0.00%** | 0.46% | 3.1% (heal clear-case 11.3%) |
| **r17-v2b** (+1B tokens with real-app gold) | sim 84.2% / real 83.6% | sim 77.8% / real 80.0% | 0.02% sim, 0.00% real (derived gates) | 0.23% sim, 0.00% real | heal 6.0% clear; real duplicate 8.2% (14% held-out apps) |
| 150M teacher (t150-v2a, 1B tokens, v2 + real gold) | sim 81.8% / real 82.0% | sim 76.5% / real 78.1% | – | – | lower than r17-v2b everywhere, so distillation was skipped |
| **r17-v2c** (+ on-policy round a, v2.2 retry labels) | sim 84.4% / real 83.7% | sim 77.8% / real 79.9% | 0.02% sim, 0.00% real | 0.22% sim, 0.00% real | guard recall on clear 2.1% (v2b 0.6%); heal gain 5.6% (v2b 3.8%); real duplicate 11.2% |
| Next: r17-v2d (mass gate) vs r17-v2dT (gain gate), winner ships as model 0.2.0 | 10.4M sim gold + 51M unlabeled + 616k real | in progress | | | | |

### r17-v2a on held-out data (details)

| Set | Diagnosis | Action | Guard FIR | Heal FIR | Recall at shipping gates | Recall at gate 0.5 |
|---|---|---|---|---|---|---|
| Sim test (`sim2e`) | 84.4% | 77.9% | 0.00% | 0.46% | heal 6.8% | heal 45% on clear cases (harm 1.8% of rows) |
| Held-out app features (`sim2f`) | 81.0% | 77.4% | 0.00% | 0.75% | heal 6.8% | – |
| **Real apps, eval set (16,600)** | – | – | **0.00%** | **0.00%** | duplicate 0.6%, stale 1.0% | **duplicate 35% (64% on held-out apps)**, broken state 10%, stale 9%, with FIR 0.05–0.35% |

**Reading.** v2 kept v1's safety and made the model much better at ranking, but the fixed 0.9/0.8 gates were
chosen before labels became expected costs and now block nearly every action. Next:
- **Thresholds:** derive per-tier, per-trigger gate thresholds from held-out data (FIR ≤ 0.1% guard / 0.5% heal on
  clean real-app and sim traffic; fit on dev, verify on test) and ship them in the model's meta.json.
- **Training:** finish the 150M teacher (with real-app gold), distil, and run DAgger rounds.

### Data-derived gate thresholds (r17-v2a)

The thresholds are fitted per tier and trigger on held-out dev data, under these constraints: FIR ≤ 0.1% (guard)
or ≤ 0.5% (heal), and harm ≤ 0.2% or ≤ 1%. Each constraint must hold at the 95% upper confidence bound. The
thresholds ship in the model's `meta.json` `gate`. Verified on held-out test (95% bootstrap intervals):

| Policy | Fires | FIR sim | FIR real apps | Harm (sim / real) | Recall on clear cases | Gain captured |
|---|---|---|---|---|---|---|
| guard, derived gates (0.70–0.90) | 0.14% | 0.03% [0.00, 0.08] | 0.00% | 0.01% / 0.00% | 2.5% | 3.0% |
| guard, fixed 0.9 | – | 0.00% | 0.00% | – | 0.2% | 0.04% |
| heal, derived gates | 0.99% | 0.19% [0.13, 0.25] | 0.00% | 0.05% / 0.04% | 5.2% | 5.1% |
| heal, fixed 0.8 | – | **0.66%** [0.56, 0.77] (over the limit) | – | – | 12.0% | 9.3% |

The derived gates keep both tiers inside their safety limits on data never used for fitting. Recall is now
limited by the model's discrimination, which is what the 150M teacher, distillation and DAgger rounds target.

### Observe mode: detection quality (r17-v2b)

A *detection* is GenClass reporting a problem, such as "this response overwrote newer state", without changing
anything. This is the phase-1 product. Detections fire when the top diagnosis is not `expected` and its probability
is ≥ `gate.report`.

| Held-out test set | Report threshold | Detected | Precision | False detections on clean real-app traffic |
|---|---|---|---|---|
| Real apps never trained on (eval set) | 0.70 | duplicate submits **76%**, stale overwrites **43%**, broken state 27% | 0.96 | 0.62% |
| Real apps never trained on (eval set) | **0.85 (shipped)** | duplicate ~76%, stale 28% | higher | **0.36%** |
| Simulated apps (sim2e) | 0.70 | 50.9% of anomalies | 0.91 | gold-expected rows: 2.59% (over the 2% limit) |
| Simulated apps (sim2e) | 0.85 | – | – | 1.11% |

Per-class precision / recall at 0.70 on sim2e:

| Class | Precision | Recall |
|---|---|---|
| failing | 0.95 | 0.78 |
| slow | 0.94 | 0.91 |
| transient | 0.88 | 0.81 |
| stale | 0.87 | 0.57 |
| duplicate | 0.80 | 0.49 |
| inconsistent | 0.97 | 0.53 |
| conflict | 0.89 | 0.54 |

The shipped threshold, 0.85, was chosen after the dev-fitted 0.70 failed the simulated false-detection limit on
test, so that one choice is test-informed. Future exports fit with a stricter dev margin.

### On-policy round a (the model acting inside the simulator)

| Gate | Acts | False interventions among acts | Harmful (≥ +1 cost) | Misses (clear action skipped) |
|---|---|---|---|---|
| shipping (0.9 / 0.8) | 2.6% of decisions | 12% | 366 | 43,662 (9.7%), mostly request and failure |
| exploratory 0.5 | 21.5% | 36% | 15,054 | 29,913 |

Where the false interventions come from:
- `coalesce` of deliberate repeated actions;
- `retry` and `serve_cached` during real outages;
- `discard` where the response wasn't actually stale;
- `rollback` / `resync` on coincidental relations.

The worst `retry` harm (POSTs that had already committed) is now prevented by the v2.2 rule: retry only when the
request is idempotent or carries an idempotency key. These rows train the next student, up-weighted.

### On-policy round b (r17-v2b with its data-derived gates, situation-v2.3)

| Gate | Acts | False among acts | Harmful | Misses |
|---|---|---|---|---|
| shipping (the model's own gates) | 1.9% | 11% | 201 (0.09% of rows) | 10.9% |
| exploratory 0.5 | 22% | 36% | 14,920 | – |

Compared with round a:
- **failure** is much cleaner: 6% of acts false, and 8 false retries vs 198, thanks to the v2.2 retry rule;
- **delivery** now acts: 99 acts, 18% false.

Remaining issues:
- the **heal transition gate (0.55) is too loose on-policy**: 41% of its acts are false. Gates are being refitted on
  on-policy dev data, falling back to the tier default where evidence is thin;
- **request** acts are 19% false, mostly coalescing deliberate repeated clicks.

### Head-to-head for model 0.2.0 (all on the shipped q8 outputs)

Shipped (dev-fitted) operating points, held-out test:

| | v2c | v2d (mass gate) | v2dT (gain gate) |
|---|---|---|---|
| guard FIR (sim) | 0.016% | 0.006% | 0.003% |
| heal FIR (sim) | 0.21% | 0.07% | 0.105% |
| heal gain captured | **5.2%** | 4.4% | 4.4% |
| heal real-app action recall | **9.8%** | 5.5% | 0.7% |
| FIR on real apps | 0.00% | 0.00% | 0.00% |

At equal safety (one global threshold swept on the same test records), v2dT captures the most:

| | heal gain at FIR ≤ 0.05 / 0.1 / 0.2 / 0.5% |
|---|---|
| v2dT | 2.1 / 3.4 / 6.2 / 12.3% |
| v2d | 1.6 / 2.5 / 5.3 / 10.0% |
| v2c | 1.6 / 2.8 / 4.6 / 8.3% |

v2dT also leads guard-mode real-app recall at FIR ≤ 0.5%: 14.1%, against 3.1–3.4%.

**Why v2dT ships conservatively.** There are too few clean real-app dev rows to certify per-trigger margins, so the
fit falls back to strict defaults. The same thin evidence pushes `gate.report` up to 0.97–0.99. Next: a large
real-app certification dev set (dev apps only), then refit all three, then pick 0.2.0 by its shipped operating
point.

**Quantization.** The q8 export was fixed by moving to MatMulNBits block 16: 223/223 decisions match PyTorch,
the file is 10.16 MB, and it is fp16-free.

### Model 0.2.0 (r17-v2dT, gain gate, three aggressiveness profiles)

Gates are fitted on the shipped q8 outputs, using the real-app certification set (counted per trajectory) and
shipping-gate on-policy rows. Results on held-out test:

| Profile | guard FIR | guard harm | guard recall (clear / real) | guard gain | heal FIR | heal harm | heal recall (clear / real) | heal gain | report | detected (duplicate / stale / broken) |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.1.0 (v2b) | 0.01% | 0.00% | 0.6% / 0% | 0.8% | 0.07% | 0.04% | – / 5.7% | 3.8% | 0.85 | 76% / 28% / – |
| 0.2.0 cautious | 0.005% | 0.007% | 2.4% / 1.4% | 3.1% | 0.26% | 0.06% | 3.7% / 3.8% | 3.2% | 0.95 | 72% / 28% / 0% |
| **0.2.0 balanced (default)** | 0.13% | 0.03% | 7.8% / 7.5% | 6.7% | 0.59% | 0.11% | 7.1% / 10.4% | 5.7% | 0.90 | 75% / 30% / 6% |
| 0.2.0 eager | 0.54% | 0.11% | 14.2% / 21.0% | 12.5% | 1.84% | 0.29% | 17.1% / 24.2% | 14.2% | 0.70 | 77% / 45% / 13% |

The 0.1.0 row comes from the earlier, stricter fit without the certification set, so it is not exactly
like-for-like. FIR on real apps is 0.00% for every profile.

Why v2dT: v2d is better in heal mode (gain 8.1% vs 5.7%, real recall 21.8% vs 10.4%), and v2dT is better in guard
mode (6.7% vs 4.2%). Guard is the default mode, so v2dT ships. Choosing the model per mode is an open item.

Targets: guard FIR ≤ 0.1% (met), heal FIR ≤ 0.5% (met), calibration error ≤ 0.02 (not yet measured for 0.2.0; r17-v2b: 0.021–0.023),
diagnosis ≥ 95% (not yet), clear-case recall ≥ 80% (not yet).

The stage-1 row comes from the 200 sim sample rows (`training/EVAL.md`). On its own curriculum test set, stage 1
scores 98% / 98% with 0% FIR.

## 2. R17 vs R32 (choosing the shipping model)

| Model | q8 size | WASM, 1 thread, ms at 500 / 780 / 1,170 tokens | Final round 1 diagnosis / action / guard FIR |
|---|---|---|---|
| **R17** (ettin-17m, 16k pruned vocab) | **9.58 MB** | **177 / 323 / 589** | 90.5% / 81.9% / 0.05% |
| R32 (GenClass 0.1 / ettin-32m, pruned) | 22.5 MB | 569 / 954 / 1,580 | 89.7% / 81.8% / 0.05% |
| GenClass 0.1 (original) | 57 MB | ≈ 900 at 780 | not trained for this |

**Decision:** R17 is the default on every device. It matches R32 at about a third of the size and latency. Both
q8 exports are fp16-free, so they run on WebGPU without `shader-f16`, and agree with PyTorch on 223/223 decisions
in onnxruntime-web.

## 3. Why round 1 was timid (format v1 vs v2)

From `sim/SEPARABILITY.md`:

- A linear model on the visible situation text reaches the same recall ceiling as R17, so the limit is
  information, not capacity.
- 62–82% of clear actionable rows had a benign twin with an identical fact set.
- 24% of clear rows were mislabelled `expected`, which the gate never acts on. Fixed by S1.
- Labels were hindsight-certain about things a runtime cannot observe: the user's next action, outage length,
  and whether a failed write committed. Fixed by S2, so labels are now expected cost given what is observable.

Format v2 adds measured facts (would put back a replaced value, overwrites newer typing, response changes
nothing, known-stale values, cadence, failure scope, repeat-click evidence, …). Its effect on visible-text
separability (100k rows, v1 → v2):

| Trigger | Benign look-alike rate | Linear recall at 1% FIR |
|---|---|---|
| failure | 40% → 17% | 6% → 11% |
| request | 48% → 38% | 11% → 15% |
| stall | 31% → 5% | – |
| mutation | 8% → 2% | – |
| inconsistency | – | 10% → 20% (AUC 0.73 → 0.81) |

## 4. "Never make a correct app worse" (runtime design comparison)

GenClass with an always-passive model, compared against observe mode:

| Runtime | Real apps, clean runs changed | Conduit (React/Redux RealWorld) | Demos (guard, zero actions) |
|---|---|---|---|
| v1 (store-write holds) | 4/198 (2 apps) | **never renders its home feed** | board 11 card jump-backs, editor 37 overwritten keystrokes, checkout 24 reset quantities, search clean latency 6 → 389 ms |
| **v2 (network-boundary decisions)** | **0/396** | identical, 0/30 | holds only at delivery; clean typeahead makes 0 model calls and holds for 0 ms |

Chaos runs under v2: 3/198 changed. A request held about 25 ms drew a different simulated network outcome (open
item).

## 5. Demos

### Model 0.2.0, runtime 0.1.0-beta.4 and heal/overnight (2026-10-09, local, `bench/heal/`)

10 chaos + 5 clean seeds per demo and mode, Playwright, telemetry off, model served locally (WASM, 4 threads).
Chaos bug rate over the six demos (60 trials per cell); FI = false interventions on 30 clean trials.

| configuration | off | observe | guard | heal | actions guard / heal (chaos) | FI guard / heal |
|---|---|---|---|---|---|---|
| beta.4, balanced (default) | 72% | 70% | 72% | 73% | 2 / 3 | 0 / 0 |
| beta.4, cautious | – | – | 72% | 77% | 0 / 0 | 0 / 0 |
| beta.4, eager | – | 72% | 73% | 75% | 6 / 12 | 2 / 0 |
| beta.4, margin 1 for every trigger | – | – | 70% | 77% | 20 / 39 | 3 / 3 |
| A/B, beta.4 arm (simultaneous) | 72% | 72% | 70% | 70% | 3 / 1 | 0 / 0 |
| A/B, heal/overnight arm (47f292c) | 73% | 70% | 73% | 72% | 1 / 1 | 0 / 0 |

Nothing is healed at the shipped gates: candidate gains are rarely above the margins (median ≈ 0; 3–8% of
discard/retry candidates reach 4). Differences under ~5 points are noise (cautious, with no action at all, differs
from balanced by 4 points in heal). A pilot app (a production Next.js ordering site, 9 fault scenarios): the only bug, a duplicate order after a
lost-commit 502 and a re-tap, occurs in every mode; 0 actions, 0 false interventions.

### Automatic state discovery (2026-10-10, local, `bench/heal/`, branch `feat/one-line`, model 0.2.0, balanced)

**Demos, stores registered by hand vs found by discovery** (`GENCLASS_DISCOVER=1` build: `useGenClassState` is plain
`useState`, the Redux enhancer is the Redux DevTools one, the Zustand middleware is `devtools()`; 5 chaos + 3 clean
seeds per demo and mode; small samples):

| demo | stores, manual | stores, discovered | decisions observe / guard, manual | discovered | detections observe / guard, manual | discovered | chaos bugs (off / observe / guard) manual | discovered |
|---|---|---|---|---|---|---|---|---|
| checkout (React) | `cart`, `orders` atoms | one observed React store (both states) | 23 / 20 | 24 / 21 | 9 / 10 | 7 / 8 | 4 / 4 / 4 of 5 | 4 / 4 / 4 of 5 |
| board (Zustand + React) | `board` adapter | observed React `useSyncExternalStore` (Zustand `devtools` is off in a Vite production build) | 76 / 73 | 72 / 73 | 14 / 14 | 6 / 6 | 4 / 3 / 4 | 4 / 3 / 4 |
| editor (Redux) | `notes` adapter | `notes` adapter (discovered, controllable) | 50 / 53 | 47 / 50 | 21 / 20 | 23 / 18 | 5 / 5 / 5 | 5 / 5 / 5 |

Delivery decisions with discovery: checkout 2 / 2, board 32 / 33, editor 19 / 13 (manual 2 / 1, 31 / 26, 17 / 17). No
actions ran in either build (as in the night report at these gates); no clean-run bugs.

**The pilot app (only the one line, React state):** stores found `orderPage`, `addToOrder` (named after rendered elements:
production names are minified) and `er` (minified `MenuBrowser`). The nine existing scenarios: decisions unchanged
(12 per mode over 27 trials: failure 9, request 3; detections 9), since each of its page loads sees at most one response
per request kind that changes state. New scenario `order-poll-reorder-2` (another device removes a line, the guest
removes the other while the next ticket poll is answered 3 s late): **3 / 3 delivery decisions with discovery, 0 / 3
with `autoState: false`**, all `expected` (correct: the app drops stale polls; no bug in any mode). Overhead: see the
package README "Costs" (+7 KB first-load JS, walk p95 under 2 ms at 4× throttling, +0.5 MB heap, no new long tasks).

### Flow expectations (0.3.0, opt-in: `learn.expectations`): not yet measured

The layer ships **off by default** in 0.3.0 (owner decision, 2026-10-13) until the gate below has run; its
first-load cost with the lazy import is in §10.

The learned-flow expectations layer (`docs/runtime/EXPECTATIONS.md`; reporting only, no model, no action) has unit
tests on the fake clock but no demo or real-app measurement yet. Its acceptance gate before any public claim: zero
`expectation` reports across the six demos' clean trials (15 per mode per demo, `bench/heal/`), reported next to
how many of the demos' silent-flow bugs (stuck "Placing…", lost commit) it names, plus a two-session run on the
stored path (the trials start in a fresh browser context, so they never load stored flows). Measured so far:
first-load JavaScript, minified + gzip, `/auto` 106.5 KB and `GenClass.init()` 99.1 KB (`test/bundle.test.ts`, CI
run 38455195053 on branch `wave1/expectations`, 2026-10-13, after the review fixes; 105.8 / 98.3 KB in run
38448983470 before them), against about 99 KB and 91 KB before the layer (the README's figures at 0.2.2, where
`test/bundle.test.ts` kept them under 100 / 92 KB): about +7.5 KB per entry.

### v0.1 model, untrained for this (2026-10-08, baseline only)

| Demo | Bug rate Off | Guard | Heal | False interventions on clean runs |
|---|---|---|---|---|
| search | 23% | 23% | 27% | 0 |
| editor | 83% | 90% | 87% | 0 |
| checkout | 70% | 77% | 83% | 0 |
| status | 100% | 100% | 100% | 0 |
| board | 57% | 63% | 77% | 0 |
| decisions | 83% | 97% | 97% | 0 |

Guard executed 0 actions. Heal took 156 actions, which fixed nothing. These numbers are re-measured with the
trained v2 model once it exists.

## 6. Data volume

| Dataset | Rows | Status |
|---|---|---|
| Curriculum (cur1–cur4) | ~1.9M | done |
| Sim v1 phase A / phase B | 600k / 1.4M | done (v1, superseded) |
| Sim v2 gold (S1+S2 labels, 46 features, 115 domains) | **10,423,855** (7.56M train / 318k dev / 2.55M test) | done, 20 nodes in ~31 min |
| Sim v2.3 gold top-up (relation-learner fixes) | **2,107,824** (inconsistency rows 5.5% → 1.6%) | done |
| Sim on-policy round a (model r17-v2a acting in the sim; DAgger) | **1,248,131** (448k at shipping gate, 672k at explore gate 0.5) | done |
| Sim on-policy round b (r17-v2b with its own gates, v2.3) | **1,094,953** | done |
| Sim v2 unlabeled (for teacher labelling) | **51,272,078** | done (~21k rows/s per node) |
| Real-browser v2 gold (158 apps, 40+ stacks) | **616,437** (+523k unlabeled) | done; determinism 3,030/3,030, interference 0/256 |
| Real-browser v2.3 top-up (relation-learner fixes) | **221,186** (real total 837,623) | done; real inconsistency triggers 18.3% → 2.6% of decisions, genuine share 10% → 40% |
| Real-app eval set (unambiguous) | **16,600** (clean-benign 4,000, benign-salient 4,000, duplicate 4,000, genuine break 3,085, stale 1,515) | done |

## 7. Training log (summary)

| When (UTC) | Event |
|---|---|
| 10-07 13:00–17:00 | Vocabulary pruned to 16k merges. q8 exports: R32 22 MB, R17 9.6 MB. Stage-1 curriculum built. |
| 10-07 17:58–19:00 | Stage 1 on 10 nodes, for both R17 and R32. |
| 10-07 19:00–20:05 | Stage 2 pilot on pre-freeze sim data: precise but timid, because the labels were mushy. |
| 10-07 23:20 | Runtime frozen as `situation-v1`. Sim phase A: 600k rows in 41 min. |
| 10-08 00:06–01:30 | Final round 1 on phase A (R32 on 6 nodes, R17 on 4). Results in §1. |
| 10-08 00:35 | Auto-shutdown disabled with the owner's OK. Quota raised to 2,048 vCPU; nodes c12–c23 added. |
| 10-08 02:00–04:00 | Separability analysis led to the S1/S2 label fixes and the F1–F9 facts. Runtime batches 4–5 (network-boundary decisions). |
| 10-08 ~04:00 | `situation-v2` frozen. v2 generation launched: ~10M gold + ~50M unlabeled in the sim, ~495k real-browser rows. |
| next | 150M teacher on v2 gold, teacher labels on unlabeled rows, distil R17/R32, DAgger rounds (SIM `--on-policy`), EVAL. |

Compute: Azure CPU nodes (F80 and D64 sizes); the day-by-day record is kept internally.

## 8. Runtime footprint and telemetry volume (CI)

Measured by unit tests in GitHub CI (Node on `ubuntu-latest`), not in a browser and without the model. Branch
`wave1/defaults-footprint`, 2026-10-13; each value is the line the test prints in the "Unit tests" log of that run.

**First-load JavaScript** (`packages/runtime/test/bundle.test.ts`: esbuild bundles the built `dist/` the way an app
would, minified, gzip level 9, first-load chunks only; the model worker, ONNX Runtime Web and the devtools are
separate chunks loaded on demand):

| entry | `a7b60d7` (run 38442191071) | `e26c0dc` (run 38442394416) | `ebbe912` (run 38445206305) | limit |
|---|---|---|---|---|
| `@genclass/runtime/auto` (with state discovery) | 100.61 KB | 100.61 KB | 100.70 KB | 101.5 KB |
| main entry, `GenClass.init({})` | 93.13 KB | 93.13 KB | 93.22 KB | 93.5 KB |

**Telemetry volume** (`packages/runtime/test/telemetry.test.ts`, "an hour at the built-in model's maximum rate"): one
page, 1,800 mutation decisions, one every 2 s (30 a minute, the `model.maxDecisionsPerMinute` default) for a simulated
hour on a fake clock. No model: a scripted decider answers `expected` (routine) or `stale` at p = 0.97 (every decision
a detection, above the default report gate). Observe mode, situation text off, every request body counted. Defaults
are `decisionSample: 0.25`, `maxDecisions: 200` (`packages/runtime/TELEMETRY.md`, "Volume").

| commit (run) | routine, defaults | every one a detection, defaults | every one a detection, every record (`decisionSample: 1, maxDecisions: Infinity`) |
|---|---|---|---|
| `a7b60d7` (38442191071), `e26c0dc` (38442394416): summaries stopped after the cap (a bug) | 203.4 KB, 204.1 KB | 228.7 KB, 228.7 KB | 2,064.7 KB, 2,064.7 KB |
| `ebbe912` (38445206305): a summary about once a minute for the whole hour | 241.6 KB, 100 requests | 271.4 KB, 95 requests | 2,064.7 KB, 361 requests |
| of which `summary` events, `ebbe912` | 61, 39.4 KB | 61, 40.8 KB | 61, 40.8 KB |

The routine column depends on which decisions the session-id hash samples, so it moves between runs. The test fails
if either default case reaches 300 KB. A real page sends far fewer decisions to the model (only salient situations),
so these are upper bounds for one tab, not typical volumes. **Superseded for 0.3.0 by §10:** detections are no
longer sampled or capped, so the "every one a detection, defaults" case now sends every record.

## 9. Install footprint (first-load JavaScript, CI)

`packages/runtime/test/bundle.test.ts` bundles the built `dist/` the way an app's bundler would (esbuild, minified,
code splitting) and gzips (level 9) every file of the first load on its own; it prints the sizes and fails above the
limits. No model is involved, so no model, threshold or FIR applies. GitHub Actions `ci.yml`, Node 22, the same test
for both columns:

| entry | 0.2.2 | Unreleased (sink adapters, sinks by name) | limit |
|---|---|---|---|
| `@genclass/runtime/auto` (automatic state discovery; Unreleased also the sink names' proxy) | 99.17 KB in 3 files (96.25 + 2.74 + 0.19) | 99.97 KB in 3 files (97.04 + 2.74 + 0.19) | 100 KB |
| main entry, `GenClass.init({})` | 91.70 KB in 3 files (88.77 + 2.74 + 0.19) | 91.83 KB in 3 files (88.91 + 2.74 + 0.19) | 92 KB |
| script tag, `dist/genclass.global.min.js` (one file; the worker, ONNX Runtime and the sink adapters load on demand) | 113.49 KB (333.8 KB minified) | 114.86 KB (337.2 KB minified) | none |

CI runs: 0.2.2 is run 38441488459 (`packages/runtime` as tagged `v0.2.2`, which is also `main` 87481d7, with only the
size-printing bundle test added); Unreleased is run 38443030760. The Unreleased changes add 0.80 KB to `/auto`,
0.13 KB to the main entry (`SinkRecord.route` and the sink-shape check) and 1.37 KB to the script tag; the sink
adapters, their name table and the fan-out are absent from both first loads (asserted in the same test). That leaves
0.03 KB under the `/auto` limit and 0.17 KB under the main entry's, so the next change that adds to the first load
needs a smaller first load or a new limit. The 0.3.0-beta.0 sizes and limits are in §10.

## 10. Release 0.3.0-beta.0: first load and telemetry volume (CI)

Branch `release/0.3.0` (wave2/accounts-base = main 88df703 + wave1/projects, then wave1/defaults-footprint,
wave1/dev-visible-reports, wave1/expectations made opt-in and lazy, and wave1/playwright; for the release candidate
then main f8c66f2 (collector limits, accounts, the CLI's login/connect/whoami/logout, the landing page),
wave2/detect-observe dd20233 (§11) and wave2/dash-detect ac2fc6f (§12)), 2026-10-13. GitHub
Actions `ci.yml`, Node 22; each value is the line the test prints in the "Unit tests" log of that run. No model is
involved (esbuild bundles and a scripted decider), so no recall, false-intervention or false-detection rate applies
to these numbers.

**First-load JavaScript** (`packages/runtime/test/bundle.test.ts`: esbuild bundles the built `dist/` as an app
would, minified, code splitting, every first-load file gzipped on its own at level 9). From `53b04f2` on, the test
walks the first load from the app's own entry (`<stdin>`) and counts every file; the `738a05b` row used the earlier
walk, which missed the two shared chunks (2.74 + 0.19 KB).

| step (commit, CI run) | `/auto` | main entry `GenClass.init({})` | script tag (one file) |
|---|---|---|---|
| 0.2.2 (§9, run 38441488459) | 99.17 KB | 91.70 KB | 113.49 KB |
| + app tokens, `protect()` (wave1/projects 625a491, run 38436300545; earlier walk) | 100.68 KB | 93.19 KB | not printed |
| + device floor, telemetry sampling (`738a05b`, run 38461782967; earlier walk) | 102.16 KB | 94.66 KB | not printed |
| + sink adapters, sinks by name (`53b04f2`, run 38462380432) | 102.94 KB in 3 files | 94.79 KB in 3 files | 117.96 KB |
| + flow expectations, `src/learn/flows.ts` lazy (`fcefedb`, run 38463736575) | 106.16 KB in 4 files | 98.13 KB in 4 files | 126.03 KB |
| + even sampling draw (`c2f0b54`, run 38464240236) | 106.23 KB | 98.20 KB | 126.11 KB |
| **0.3.0-beta.0** (`bff4a71`, run 38465242176) | **106.24 KB** (100.26 + 3.05 + 2.74 + 0.19) | **98.21 KB** (92.24 + 3.05 + 2.74 + 0.19) | **126.12 KB** (369.4 KB minified) |
| + telemetry 429 back-off, no sampling settings in `session` (`7c7c6d6`, run 38477010836) | **106.59 KB** (100.62 + 3.05 + 2.74 + 0.19) | **98.57 KB** (92.59 + 3.05 + 2.74 + 0.19) | **126.45 KB** (370.5 KB minified) |
| + detection tiers, deferred decisions, review fixes (wave2/detect-observe `dd20233`, run 38482297879; §11) | 107.56 KB | 99.59 KB | 127.89 KB |
| **release candidate**: + main (accounts and the CLI commands: no browser code) and wave2/dash-detect (the worker only) (`18e89f0`, run 38485063587) | **107.56 KB** (101.59 + 3.05 + 2.74 + 0.19) | **99.59 KB** (93.62 + 3.05 + 2.74 + 0.19) | **127.89 KB** (374.9 KB minified) |
| limit in `bundle.test.ts` (measured at `bff4a71` + 1.5 KB, owner-approved for 0.3.0; the release candidate is 0.18 / 0.12 KB under it, so it is not re-set) | 107.74 KB | 99.71 KB | none |

The flow expectations were +7.3 KB on `/auto` when `src/learn/flows.ts` was in the first load (106.5 KB vs 0.2.2's
99.17 KB on wave1/expectations, run 38455195053). Imported lazily, and only with `learn.expectations: true`, they
add +3.3 KB (102.94 to 106.24 KB): the runtime side (learned-state persistence, the console line, the hooks) and
the overhead of the util code the lazy chunk shares becoming a 3.05 KB chunk of its own. So the lazy import moves
about 4 KB (by difference, not measured on its own) out of every first load. The script-tag build has no code
splitting and carries the flow layer inline.

**Telemetry volume** (`packages/runtime/test/telemetry.test.ts`, "an hour at the built-in model's maximum rate"; the
setup of §8: one page, 1,800 decisions from a scripted decider at p = 0.97, observe mode, situation text off, every
request body counted). Since `738a05b` detections, near-misses (a top diagnosis other than `expected`), actions and
vetoes are never sampled or capped; only routine decisions are (`decisionSample: 0.25`, `maxDecisions: 200`
routine records per page load):

| commit (run) | all routine, defaults | every one a detection, defaults | every record (`decisionSample: 1, maxDecisions: Infinity`) |
|---|---|---|---|
| `738a05b` (38461782967) | 242.4 KB, 106 requests | 2,064.7 KB, 361 requests | 2,064.7 KB, 361 requests |
| `c2f0b54` (38464240236), the even draw below | 249.0 KB, 162 requests | 2,064.7 KB, 361 requests | 2,064.7 KB, 361 requests |
| `bff4a71` (38465242176), 0.3.0-beta.0 (a longer version string in every envelope) | 250.3 KB, 163 requests | 2,067.1 KB, 361 requests | 2,067.1 KB, 361 requests |
| **`7c7c6d6` (38477010836)**: 429 back-off; `session` without `decisionSample` / `maxDecisions` (about 40 bytes once per page load, below the 0.1 KB rounding) | **250.3 KB, 163 requests** | **2,067.1 KB, 361 requests** | 2,067.1 KB, 361 requests |
| **release candidate `18e89f0` (38485063587)**: with wave2/detect-observe (§11) | **251.9 KB, 165 requests** | **2,068.5 KB, 361 requests** | 2,068.5 KB, 361 requests |

Summaries: 61 per hour in every case, 39.3 KB (routine) and 40.8 KB (detections); 40.7 KB and 42.2 KB in the
release candidate, whose summaries also carry `possibleDetections`.

**The routine-record draw** (`decisionDraw` in `src/telemetry/client.ts`). The 0.25 share was drawn from fnv1a of
"<session id>:<decision id>", whose high bits hardly depend on the last characters, and decision ids (`d1`, `d2`,
...) differ only there: CI run 38463736575 failed on a page that sent 44 of 80 routine records. Measured with a Node
script over 200 fixed session ids, 80 decisions each: fnv1a alone sent 0 to 59 of 80 per page (0.2554 overall);
with murmur3's 32-bit finalizer after it (`c2f0b54`) 9 to 32 of 80 (0.2499 overall). The unit test "the
routine-record draw is even for every session" asserts the finalized draw on the same 200 sessions (5 to 36 per
page, 0.23 to 0.27 overall). Detections never go through this draw.

**The 429 back-off** (`7c7c6d6`, ported from wave2/detect-observe): `test/telemetry.test.ts` "a 429 or a
Retry-After is a back-off" asserts, with a scripted transport, that five 429s in a row (more than the three failures
that stop a page) never stop it, that nothing is sent during a back-off (30 s, 60 s, 120 s, 240 s, then 5 minutes
with no Retry-After; exactly 5 s with `Retry-After: 5`), and that the refused batch is sent in order once the
collector accepts it. These are behaviour checks, not rates: how many pages behind one address hit the collector's
limit in production is not measured.

**Not measured here:** browser timings, the install suite (`test/install/run-all.sh`, VM only), the demos'
clean-trial gate for the flow expectations (§5), and any number with the model.

## 11. Observe-mode detection in 0.3.0: the "possible" tier and deferred situations

Branch `wave2/detect-observe` (from `release/0.3.0`), 2026-10-13. Two kinds of change: a lower reporting tier in
observe (`InitOptions.detect`, CONTRACT §8), and observe situations that used to be dropped and are now decided later
(while the model loads or reloads, while the tab is hidden; OPTIONS-SPEC §5.1, §5.3), plus four fixes (idle unload,
the body wait, superseded writes in observe, priority aging). No model-visible text changed and no action gate
reads the tiers. **The false-intervention rate is unchanged for every app without `model.unloadAfterIdleMs`** (no
action path changed; deferred decisions are gated as observe; guard and heal build nothing while the model loads, as
before 0.3.0). With `model.unloadAfterIdleMs`, guard and heal act again after the model reloads, where 0.2.x stopped
for good after the first unload: those actions are new, and their FIR was not measured. Nothing in this section was
measured end to end on this branch; the numbers below are earlier measurements of the same thresholds, which is what
the "possible" tier uses.

**Expected effect of the "possible" tier, from measurements already made.** In observe at the default `balanced`
profile, likely + possible detections are exactly the detections at the `eager` profile's report gate (0.70; the
likely ones alone are those at `balanced`'s 0.90). In observe the profile changes nothing but that gate, so the
`eager` measurements are the expected effect:

| measured | balanced (report 0.90): likely only, 0.2.x | eager (report 0.70): likely + possible, 0.3.0 observe default | source |
|---|---|---|---|
| detected with the right diagnosis, held-out real apps: duplicate submits | 75% | 77% | `training/EVAL.md`, `@genclass/runtime-model@0.2.0` = r17-v2dT table (REAL eval test split, q8) |
| same: stale overwrites (situation v2 / v2.3) | 21% / 30% | 40% / 45% | same |
| same: genuine breaks | 6% | 13% | same |
| report false-detection limit the 0.2.0 fit was held to, per clean decision, met on held-out test (real / sim) | ≤ 2% / ≤ 3% | ≤ 5% / ≤ 6%, for likely and possible together; the share of possible detections that are false is not measured and is expected to be well above the likely tier's | same ("All profiles meet their limits on held-out test"); the exact rates are not published (the gate-fit curves are on a deallocated training node) |
| bench demos, observe, buggy chaos trials with at least one detection | 39 / 42 | 41 / 43 | `bench/heal/results/demos/results-baseline-beta4-m020.json` and `results-baseline-beta4-m020-aggr-eager.json` (model 0.2.0, runtime 0.1.0-beta.4, Playwright, model preloaded, visible tab), counted again for this section with a Python script over their `raw` trials |
| bench demos, observe, clean trials with a detection (a false-detection proxy) | 2 / 30 | 3 / 29 (search seeds 1502, 1503 and status 1503, all `delivery:stale`; one of the 30 eager clean trials showed a bug and is left out) | same files |

Read with care: the bench counts are trial-level co-occurrence (a trial with any finding), not per-bug matches, and
n is small (one more clean trial with a finding in about 30). The compat matrix's false-finding baseline is at
`balanced` only (49 false findings in 880 correct-app runs, all in scenario g, polling and fan-out:
`compat/RESULTS.md`); the possible tier will add to it, by an amount not measured. Possible detections print with
`console.debug` only and reach `rt.on("detect")`, `rt.on("report")` and a `report` function only with
`detect: "possible"` set explicitly, so an app wired to those gets the likely ones by default, as before. Three
fixes below (superseded writes in observe, the body wait, the idle unload) can still add likely reports, false ones
included, at a rate not measured, and `detect: "likely"` does not turn them off; the deferred situations do not add
likely reports (they are capped at the possible tier, below).

**Deferred situations and the fixes: expected direction, not measured.**

- *Model loading.* Before 0.3.0 a page view lost every salient situation before the model was ready: those raised
  while the model loaded (3.76 s on average on the one production site reporting telemetry, runtime 0.2.1, the
  maintainers' admin view on 2026-10-13) were dropped before triage, uncounted; those raised before the idle preload
  started (after the load event, up to 5 s, then up to 2 s of idle) were counted as failOpen `not-ready`, and the
  first of them started the load. In observe both are now decided once the model is ready (at most 32 per page
  load), built at the smallest automatic situation budget while the device is not known yet. How many detections
  that adds is unmeasured: the bench and the compat matrix wait for the model before each trial (`await gc.ready`,
  preload eager), so they never exercised this path.
- *Hidden tabs.* Unmeasured for the same reason (the trials run in a visible tab). Hidden-tab timers are throttled
  and aligned (1 s, and once a minute after 5 minutes in Chrome), so background pollers can overlap: the polling and
  fan-out pattern behind all 49 false findings in the compat matrix. A hidden tab never loads or reloads the model.
  In production the loss counters (`summary.runtime.model.hiddenSkipped`, `summary.counts.failOpen`) only reach the
  raw R2 objects; no aggregate reads them yet.
- *Reported at the possible tier at most.* Because neither path has a measured false-report rate, a deferred
  situation's detection (load window or hidden tab) is recorded as possible whatever its probability: `console.debug`,
  the devtools, `summary().possibleDetections`, telemetry (`tier: "possible"`), never the likely channel, following
  the owner's precedent for the expectations layer (opt-in until measured). `detect: "likely"` turns deferral off.
  Lifting the cap needs the cold-start and hidden-tab clean run below, or the owner's explicit OK.
- *Idle unload, the 100 ms body wait, overwritten writes on slow devices, priority aging, the telemetry back-off:*
  regression tests on the fake clock (`test/deferred.test.ts`, `test/observe-delivery.test.ts`,
  `test/hold-late.test.ts`, `test/telemetry.test.ts`), no recall or false-detection number. The back-off is 30 s
  doubling (or a longer Retry-After) up to 5 minutes, for a 429 or a 503 with a Retry-After only, and a refusal after
  8 back-offs in a row (about 27 minutes) counts as a failure.
- *CPU on the user's device:* unchanged ceiling, 30 model evaluations a minute (`model.maxDecisionsPerMinute`);
  deferred decisions count against it. Raising it was not measured, so it stays.

**What CI measured on this branch** (GitHub Actions `ci.yml`, run 38471973596, commit `8501528` on
`wave2/detect-observe`; no model involved, so no recall or false-detection rate applies to these):

| | 0.3.0-beta.0 (§10, run 38465242176) | with this change (run 38471973596) | limit (unchanged) |
|---|---|---|---|
| first load, `/auto` | 106.24 KB | 107.66 KB (101.69 + 3.05 + 2.74 + 0.19) | 107.74 KB |
| first load, main entry `GenClass.init({})` | 98.21 KB | 99.69 KB (93.72 + 3.05 + 2.74 + 0.19) | 99.71 KB |
| script tag `genclass.global.min.js` | 126.12 KB | 127.63 KB (374.5 KB minified) | none |
| telemetry hour, all routine (defaults) | 250.3 KB, 163 requests | 252.2 KB, 167 requests (the sampled share follows the random session id) | test fails at 300 KB |
| telemetry hour, every decision a (likely) detection | 2,067.1 KB, 361 requests | 2,068.5 KB, 361 requests | none |
| of which 61 `summary` events | 39.3 / 40.8 KB | 40.7 / 42.2 KB (the `possibleDetections` count) | none |

After release/0.3.0 took this branch's 429 back-off and dropped `decisionSample` / `maxDecisions` from the `session`
event (§10, `e637c37`), it was merged back here (`fab159c`, CI run 38477575339): first load 107.65 KB on `/auto`
(101.68 + 3.05 + 2.74 + 0.19) and 99.68 KB on the main entry (93.71 + 3.05 + 2.74 + 0.19), script tag 127.62 KB
(374.4 KB minified); telemetry hour 251.6 KB in 163 requests all routine (summaries 40.7 KB), 2,068.5 KB in 361
requests every decision a detection (summaries 42.2 KB). Against release/0.3.0's 106.59 / 98.57 KB this branch adds
1.06 / 1.11 KB (the back-off is in both). Unit tests 890 passed, 14 skipped.

The two first loads grew by 1.42 and 1.48 KB, inside the 1.5 KB the release left; the first CI run (38471360511)
measured 107.77 / 99.80 KB, over the limits, and the code was trimmed (no behaviour change) rather than the limits
raised. Unit tests: 889 passed, 14 skipped (the model-parity tests); the telemetry-worker job 24 passed.

**After the review fixes** (hidden tabs never load the model, guard and heal skip while it loads as before, possible
detections off the app's listeners by default, deferred decisions capped at the possible tier, trigger-time route,
bounded back-off; CI run 38482297879, commit `7c12cf5`): first load **107.56 KB** on `/auto` (101.59 + 3.05 + 2.74 +
0.19) and **99.59 KB** on the main entry (93.62 + 3.05 + 2.74 + 0.19), 0.18 / 0.12 KB under the unchanged limits;
the fixes' own bytes were paid for by moving the expectation report's console text into the lazy flow chunk (the
first push with the fixes alone measured 107.92 / 99.93 KB, CI run 38481007044, over the limits). Script tag
127.89 KB (374.9 KB minified; it carries the flow chunk inline, so it grew by the fixes, +0.27 KB). Telemetry hour:
251.2 KB in 160 requests all routine (61 summaries, 40.7 KB), 2,068.5 KB in 361 requests every decision a (likely)
detection (summaries 42.2 KB). Unit tests 903 passed, 14 skipped; telemetry-worker job passed. No model involved, so
no recall or false-detection rate applies to these numbers.

**Deploy order for the aggregates** (no deploy from this branch): the telemetry-worker dashboard
(`telemetry-worker/src/dashboard.ts`, `possible_detections`) and the maintainers' admin aggregates
(`site/src/admin.js`, `possible_detections` and recent rows of kind `possible`; the live demo counter in
`site/public/live.js` skips them) both count `tier: "possible"` apart from detections. Both must be deployed before a
0.3.0 runtime reports to them; an older aggregate counts every possible detection, deferred ones included, as a
detection, and the tiers cannot be separated afterwards (the admin `daily` metric has no tier).

**Not yet measured end to end** (needs the owner's OK for the VM or a training node): the false-detection rate of the
possible tier on the 0.3.0 runtime (compat scenarios c to h and the bench clean trials, observe, default `detect`); the
exact 0.2.0 report curve (`out/gates/r17-v2dT*-report.json`); a cold-start run (no `await gc.ready`, default idle
preload, plus hidden-tab trials with background pollers) that would show how many detections the deferral adds and
how many false ones come with them, which is what lifting the possible-tier cap on deferred decisions needs; the
likely reports the three fixes add on correct apps (compat, observe, slow WASM and slow-body scenarios); and guard/heal
FIR with `model.unloadAfterIdleMs`.
## 12. Dashboard counts and the possible-issues tier (telemetry-worker, 2026-10-13)

Branch `wave2/dash-detect` (merged with `release/0.3.0`). The worker takes each page load's totals (page loads,
decisions, detections by diagnosis, possible detections, acted, triggers, diagnoses, action outcomes, vetoes, breaker
trips, fail-opens, model errors, action limits, hidden-tab skips, rate-limit drops, browser drops, sampled-out and
capped records) from its cumulative `summary`, through a per-page-load high-water mark, and from its events until the
first summary arrives (`telemetry-worker/README.md`, "Exact totals"). Routes, functions and recent rows still come
from the events.

| what | value | how |
|---|---|---|
| Counted totals vs the page load's own summary, unit fixtures | equal in every case, 0 double counts | `telemetry-worker/test/dashboard.test.ts` (CI run 38465992209, commit 8b0e949: 40 worker tests passed): a repeated batch, bigger / late older / partial summaries, a split flush in three orders including both parts processed at once, a client that sent 4 decision records for 500 decisions and 260 detections, state from the previous worker format, state swept after 2 days, a corrupt state row. Fixtures, not production traffic |
| The possible tier, unit fixtures | "Problems found" 0 and possible 1 for one possible detection sent before a summary that counts likely detections only; counted once with its decision record in the other batch, in both orders; a repeated batch adds nothing | same file, describe "possible issues: runtime 0.3.0's lower tier" (CI run 38479161101, commit 4ebc651: 45 worker tests passed). Fixtures, not production traffic |
| Local replay: 20 page loads, 1,557 events (839 decision records: every non-routine one, 1 in 4 routine), split into 276 batches of 1-12 events, 30% of them moved out of order, 30 sent twice | dashboard 1,520 decisions / 288 detections / 340 possible, equal to the page loads' own summaries; by diagnosis 288 / 340; 243 detections and 280 possible ones with a page (the rest arrived in another batch than their decision record); largest page-load state row 476 bytes | scratch replay through `aggregate()` and `stats()` on `node:sqlite` with the real migrations, seeded generator. The same replay through the worker before this fix (`9cd0799`, which counted every detect event as a detection and derived its own band from decision records): 504 detections and 60 possible |
| Dashboard page HTML (`/dashboard/<secret>`) | 50,798 bytes on `release/0.3.0` → 60,940 (gzip 15,555 → 17,526); 60,226 at `9cd0799` | `dashboardPage()` output for one fixed project (name "Acme checkout", 22-char nonce); a worker page, not part of the runtime's first-load budget |
| `/start` HTML; sample stats JSON (7 d, 2026-10-13T20:00Z) | 12,700 → 12,934 bytes; 8,580 → 9,698 bytes | same |
| Fig. 2 (possible issues) bar outline contrast | 5.72:1 light (`--ink3` #5A6684 on #FFFFFF), 7.00:1 dark (#97A3C2 on #0B1736) | dataviz `validate_palette.js` `contrast()`; one series, no new hue (ring keys reuse the validated type hues), so no CVD pair to check |

**Possible issues.** The tier is the runtime's own (§11, `wave2/detect-observe`): in observe, by default, a decision
whose top diagnosis is not `expected` with confidence under the report gate but at or over the eager profile's report
value is sent as a `detect` event with `tier: "possible"` and counted in `summary.counts.possibleDetections`. The
worker counts exactly that, in its own metrics, never in the problem counts, and derives nothing from decision records
(an earlier version of this branch counted a band [0.70, report gate) of decision records itself, in every mode; that
listed decisions the console never showed, and counted runtime-possible ones as detections). Reporting only: no action
reads it, so FIR 0 by construction. Its false-report rate is the runtime tier's: at `balanced`, likely + possible are
the detections at `eager`'s report gate, which on held-out real apps detect 77% / 45% / 13% of duplicate / stale /
broken cases against 75% / 30% / 6% for likely alone, with report false-detection limits of ≤ 5% REAL / ≤ 6% SIM
against ≤ 2% / ≤ 3% (limits met on held-out test; the exact rates are unpublished; `training/EVAL.md`, §11). On the
bench demos, clean trials with a detection were 3 / 29 at `eager` against 2 / 30 at `balanced` (§11). Under
`release/0.3.0`'s defaults the client never samples or caps detect events or the records of non-`expected` decisions,
so the tier's count is exact, not a sample.

**Sampled metrics.** Average decision time, decision mode, executed, routes and functions come from the decision
records that arrived. Routine records are sampled (1 in 4, at most 200 per page load), so these lean towards
non-routine decisions; the session event no longer carries the sampling settings (§10), so the worker cannot
reweight, and the page now labels them as records ("average of N decision records received").

Not measured: anything on production data. No released runtime sends a token yet (`0.3.0` will), so no real page
load reaches a dashboard, and no released runtime sends `tier`.
