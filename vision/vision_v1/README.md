# GenClass Vision v1: a small visual-bug model distilled from Clef

Vision v1 judges one page element from its screenshot crop and a few measured facts, the way Cloudflare's Clef
does in `vision/clef` (branch `wave2/clef-eval`), but small enough to run on a CPU next to the page check: a
pretrained ImageNet MobileNetV3-small over a 224 x 128 letterboxed crop, 64 measured facts joined before the head,
and heads that copy Clef's answers under its two prompts (4.8 MB ONNX, 0.54 ms per crop on one CPU thread). Labels
for evaluation come from AI agents, not people. Results: [`../results/vision-v1/RESULTS.md`](../results/vision-v1/RESULTS.md). The
test set and the ship rule were fixed before training: [`../results/vision-v1/TEST-FROZEN.md`](../results/vision-v1/TEST-FROZEN.md).

Everything heavy runs on a cluster node (c20 holds the v2 crawl under `~/vision-out/v2`; this package writes under
`~/vision-out/vision-v1`). Crops, screenshots, crop ids and hosts never leave the node, except the blind labelling
sheets of the fresh test set, which go to a private scratch folder for the AI-agent labellers. Committed files hold
aggregates only.

## Pieces

| file | what |
|---|---|
| `common.py` | paths, the Clef evaluation's dev/report split, crop geometry, the degrade step, the letterbox, the 64 measured facts |
| `build_index.py` | chooses every crop: 100,000 natural elements of train hosts (all crawl candidate crops, then stratified elements cut from the viewport shots), injected faults the pixel check saw with "before" and "clean" pairs, the labelled crops |
| `cut_crops.py` | cuts the shot crops (0.5x / 0.75x JPEG shots brought back to CSS px) |
| `check_cut.py` | geometry check of the shot crops against the crawl's full-resolution crops |
| `clef_prompt.py`, `metrics.py` | the Clef evaluation's prompt and metrics, copied verbatim; `parity.py` checks the prompts match byte for byte |
| `clef_label.py` | labels crops with Clef through the private eval worker: resumable, retries with backoff, a hard spend cap over every answer on disk |
| `freshtest.py`, `LABELLING.md`, `label_chunks.py` | the fresh test set: held-out hosts, strata, blind sheets, AI-agent label passes, adjudication, resolution, digest |
| `pack.py` | letterboxed uint8 arrays (and degraded copies of full-resolution crops), facts, metadata |
| `train.py` | the student: backbone, facts, four heads (family and verdict under Clef's two prompts), distillation and injected-fault targets |
| `evaluate.py` | dev numbers and thresholds; the one test evaluation (refuses to run twice) |
| `export.py`, `portable/score_onnx.py` | ONNX fp32 and int8, `spec.json`, a self-contained scorer; size, latency and parity |
| `select_model.py` | the model choice on dev: mean dev AP of each run's last three epochs |
| `dryrun.py` | a stand-in test set of training-host crops with random labels, to exercise `evaluate.py final` |
| `port_check.py` | the export scored in a clean environment against PyTorch |
| `report.py` | markdown tables from the evaluation JSONs |
| `bench.py`, `profile_loader.py` | CPU throughput checks |
| `bg.sh`, `run_quarter.sh`, `run_half.sh` | detached runs on the node; one training run per quarter (19 threads) or NUMA half (38) of an 80-vCPU node |

## Run (on the data node)

```
python3 -m venv --without-pip ~/vv1-venv && ~/vt-venv/bin/pip --python ~/vv1-venv/bin/python install pip
~/vv1-venv/bin/pip install torch==2.14.1 torchvision --index-url https://download.pytorch.org/whl/cpu
~/vv1-venv/bin/pip install pillow numpy onnx onnxruntime onnxscript orjson
cd ~/vv1-code
python build_index.py --natural 100000 && python cut_crops.py && python check_cut.py
python parity.py --ref <Clef evaluation work dir>/items.jsonl
python pack.py
python freshtest.py hosts                                 # before anything trains
export CLEF_EVAL_URL=https://genclass-clef-eval.mehar-144.workers.dev CLEF_EVAL_KEY_FILE=<key file, mode 600>
python clef_label.py run --items ~/vision-out/vision-v1/index/nat.jsonl --variant clef-img-p3 --shuffle --concurrency 24
python clef_label.py run --items ~/vision-out/vision-v1/index/nat.jsonl --variant clef-imgonly-p2 --shuffle --concurrency 24
python freshtest.py build && python freshtest.py digest   # then commit TEST-FROZEN.md
python label_chunks.py --pass A && python label_chunks.py --pass B   # sheets to the labellers
python freshtest.py adjudicate && python freshtest.py resolve
bash run_quarter.sh 0 f-s-lr5 --arch mnv3s --epochs 12 --w-inj 0 --lr 5e-3 --lr-backbone 2e-3   # the chosen run
python select_model.py                                     # dev only
M=~/vision-out/vision-v1/models/f-s-lr5
python evaluate.py dev --model $M                          # thresholds, dev numbers
python dryrun.py --dir /tmp/vv1-dry && VV1_TEST_DIR=/tmp/vv1-dry python evaluate.py final --model $M
python evaluate.py final --model $M --input full --score any     # once
python export.py --model $M --thresholds $M/eval-dev-full-any.json
python port_check.py prepare --model $M --dir /tmp/vv1-port      # then score_onnx.py in a clean venv
python port_check.py compare --model $M --dir /tmp/vv1-port
```

Other input sizes: `VV1_INPUT=320x192 python pack.py --sets lab,nat` and the same variable for training, evaluation
and export (each size has its own pack directory; checkpoints record their size).
