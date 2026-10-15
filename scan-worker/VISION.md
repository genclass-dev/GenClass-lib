# GenClass Vision (beta) in the page check

GenClass Vision is a small image model that gives each measured visual finding of the page check a second opinion. It
looks at the same screenshot crop the model judge (Clef) is shown and returns a score from 0 to 1. **It changes no
finding and no score**: the findings, the judge's outcomes and scan-score/3 are computed exactly as without it. The
report shows its score on each finding it saw ("Vision 0.91") and, under "GenClass Vision (beta)", the findings it flags
that are not scored, with their crops and one line: "Beta model. On our test, about half of what it flags is a real
bug."

Code: `src/vision.ts` (the facts, the R2 read, the tab runner), `src/vision-page.ts` (the tab: onnxruntime-web, the
letterbox, the model's run), `visionView` in `src/scan.ts`, `findingVision` and `report.vision` in `src/report.ts`, the
chip and the list in `src/page.ts`. Tests: `test/vision.test.ts`.

## Model card

| | |
|---|---|
| name | `genclass-vision-v2` (GenClass Vision v2, the run `A5s2`) |
| network | MobileNetV3-small (ImageNet weights) over a 224 x 128 letterboxed crop, the 64 measured facts through a small MLP joined before a 384-unit trunk; heads: verdict (8), family (11) |
| size | 1,188,787 parameters; ONNX fp32 4,767,031 bytes, sha256 `08ab85836b5f28fb7646488145ec9a712dfc1e83dcd9467024420180d1e4a1d3` |
| speed | 0.53 ms a crop, one CPU thread (AMD EPYC 9V45, onnxruntime 1.31, batch 1); in the page check's tab about 35 to 41 ms a crop including the JPEG decode and the letterbox (below) |
| score used | `any` = 1 - P(verdict = fine), the student's copy of OpenAI's notFine |
| operating point | `any` >= 0.7515736222267151, `thresholdsFromFreshDev["secondStage:v2"]` in `spec.json`: the fresh-dev threshold for recall 0.5, chosen before the test set was read |
| teacher | OpenAI's Decisions API (`POST /v1/decisions`, `gpt-6-luna`, public beta) on 100,000 natural crops for the verdict; the family head on OpenAI's family answer averaged with Clef's |
| training data | 74,362 natural crops of crawled public home pages (round-2 train hosts of the Vision crawl), none from the dev or test hosts |
| labels for evaluation | AI labeller agents (Claude subagents), not people: a fresh dev set of 600 crops (two blind passes and an adjudication pass, kappa 0.788) and Vision v1's frozen test set of 1,300 crops (kappa 0.711), used for the second time |
| results | [`vision/results/vision-v2/RESULTS.md`](https://github.com/genclass-dev/GenClass-lib/blob/cbf92930fbf7408b35d395387ed7ad8dd2a52e20/vision/results/vision-v2/RESULTS.md) on branch `wave2/vision-v2-student` |

What it was measured to do (test set, unclear crops left out of ranking, counted as not real in precision):

- **Ranking, any problem:** average precision 0.611 on 1,052 crops (173 real). Clef 0.615 (paired difference
  -0.004 [-0.099, 0.085]: level), OpenAI 0.651 (level within the interval), Vision v1 0.518 (beaten).
- **Behind the measured rules, the setting the page check uses:** the crawl's measured rules flagged 500 test crops,
  75 real (15%). At the operating point above Vision kept 69 of them, 33 real (**47.8%**), recall 0.191 of all real
  crops. Clef in the same place kept 50, 28 real (56%).
- **No bug family ships.** At the fresh-dev thresholds no family detector reached 60% in-family precision with at least
  10 flags on test (media 14%, responsive 18%, text 50%). The family heads are not used here.

Why it is a beta and not scored: the labels are AI labellers', the 60% bar was not met, the dev thresholds have not
transferred to the test labellers (RESULTS.md, "Why the thresholds did not transfer"), and the 48% was measured behind
the crawl's rules (vision/src/candidates.mjs `v1Rules`), the precursor of the visual checks the page check runs, not
behind those checks themselves.

## How it runs

- **Where.** A tab of its own in the scan's Cloudflare browser (Browser Rendering), in a window of its own, never the
  scanned page: the site's scripts cannot see or change the model, its input or its answers. The tab's requests are
  intercepted: only GETs to `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/` (the version
  `@genclass/runtime` pins) go out; everything else is aborted.
- **The model's bytes.** R2 bucket `genclass-models` (binding `MODELS`), key `vision/genclass-vision-v2/model.onnx`
  (and `spec.json` next to it). The site worker serves only `@genclass/runtime-model@<version>/files/<file>` keys from
  that bucket, so these stay private (`genclass.dev/model/vision/...` is 404). The worker reads the object once per
  isolate, checks its sha256 against `VISION_SHA256` (a mismatch turns Vision off), and hands it to the tab as base64
  in 768 KB pieces over the scanner's DevTools connection, so the views' messages are not held behind one large message.
- **When.** The tab opens when the first view has a measured finding cropped by the judge, not when the browser starts:
  most pages have no visual finding to score (five of the nine test-copy scans in CALIBRATION.md), and the model's
  6.4 MB of base64 then stays off the DevTools connection that every intercepted request of the three page loads waits
  on. A first build started it with the browser; its views phase ran from 2.0 s faster to 3.0 s slower than production's
  on five pages, which is within the spread of scans where Vision never opened (+1.8 s and -3.1 s against production),
  so the change is for cost and isolation, not a measured speed-up. Started at the first crop, it loaded in 2.8 to 3.8 s
  while the other views finished, and scored while the race probe and the guard pass ran. After the guard pass the scan
  waits for its last answers at most `VISION_TAIL_MS` (2.5 s), in parallel with the judge's answers.
- **Which elements.** The measured visual findings the judge cropped (the judge leaves out `page-overflow-x`,
  `image-broken`, `text-template-leak`, `layout-shift` and findings with no element; its cap of 40 calls a scan and 20
  findings a view applies). Not the elements the measured checks abstain on: Vision's precision there was not measured
  at this operating point.
- **Input, as in training** (`spec.json`):
  - the crop: the element's border box plus 24 CSS px each side, clipped to the viewport, captured at CSS-pixel
    resolution (every view runs at device scale factor 1), JPEG quality 90: the judge's own crop, unchanged;
  - the letterbox: Pillow's resize ported line for line (`letterbox()` in `src/vision-page.ts`: bicubic a = -0.5 up to
    2x, bilinear down, 22-bit fixed point, horizontal pass then vertical, sizes rounded half to even), centred on grey
    128, RGB 0..255, no normalisation;
  - the 64 facts: `visionFacts()` is `score_onnx.py facts()` line for line, on the row `src/judge-page.ts` "facts"
    measures the way `vision/src/extract.js` measured the training crops, with the two differences the training data
    had made up: the child count capped at 12 (as `vision_v1/build_index.py`), and the undefined-`var()` fact, which
    the judge measures only for `css-var-undefined` findings, measured for the others by extract.js's own `var()` pass
    (`judgePage("vars")`) in what is left of the judge's time in that view (none left: taken as 0, counted in
    `report.vision.varsUnmeasured`).
- **Failure.** Every step has a timeout bounded by the scan's time left. A tab that does not open, onnxruntime-web
  that does not load, a model that cannot be read or does not match its sha256, an answer that is not the model's
  output shape (11 family and 8 verdict probabilities in [0, 1]): Vision says nothing about that crop, the report's
  `vision.ran` is false when it scored nothing, and everything else is unchanged. The page then shows no Vision chip
  and no list.

## Parity with the training's scorer

The reference is `vision/vision_v2/portable/score_onnx.py`, the self-contained scorer exported with the model (its
`letterbox()` and `facts()` are the model's input contract). The fixtures are synthetic: 16 images drawn from integer
formulas and 18 made-up element rows (`scripts/vision-fixtures.py`; nothing crawled), with the reference's outputs in
`test/vision-fixtures.json`, computed on the export's own node (c20: Pillow 12.3.0, numpy 2.5.4, onnxruntime 1.31.0);
Pillow 11.2.1 on a Mac gave the same bytes.

| what | how | result |
|---|---|---|
| letterbox (16 images: bicubic to the 2x cap, bilinear down to 0.16x, an exact fit, a 4 x 4 crop, a half Python rounds to even, wide and tall crops) | `test/vision.test.ts`, in CI | **byte-identical** to Pillow (sha256 of the 224 x 128 x 3 input), all 16 |
| the 64 facts (18 rows reaching every branch) | `test/vision.test.ts`, in CI | **1,152 of 1,152 values identical** to the Python's float32 |
| the model: the scanner's letterbox and facts, onnxruntime-web 1.30.0 WASM (one thread, Node 22) against `score_onnx.py` (onnxruntime 1.31 CPU), 16 images | `scripts/vision-parity.ts`, needs the private model, run once on 2026-10-15 | max abs difference: any 1.19e-6, family 8.9e-7, verdict 1.25e-6; 0 of 16 on the other side of the threshold |

Not measured: the JPEG step. The training's test crops were PNG viewport shots cut and saved as JPEG quality 0.9 by a
Chrome canvas and decoded by Pillow; the page check's crops are JPEG quality 90 from Chrome's `Page.captureScreenshot`,
decoded by Chrome (`createImageBitmap`) in the tab. Both are libjpeg-turbo at the same quality, but neither the encoders'
settings nor the decoders' were compared pixel for pixel, so a difference of a few levels per pixel is possible there.
Phone views also differ: the crawl resized a desktop window to 390 x 844, the page check emulates a phone (mobile
viewport, touch).

## Test copy runs (2026-10-15, genclass-scan-test, report version 8)

See `CALIBRATION.md`, "GenClass Vision (beta)".
