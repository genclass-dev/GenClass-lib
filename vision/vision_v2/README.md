# GenClass Vision v2: the Vision v1 student, taught by OpenAI's Decisions API

Vision v2 is Vision v1's small image model (vision/vision_v1 on `wave2/vision-v1`: MobileNetV3-small over a 224 x 128
letterboxed crop, 64 measured facts joined before the head) retrained with a different teacher: OpenAI's Decisions API
(`POST /v1/decisions`, `gpt-6-luna`, public beta), asked the `luna-img-p3` question that `wave2/openai-decisions` chose
on dev (image + facts + caution; score notFine = 1 - P(verdict = fine)). Thresholds and the model choice come from a
fresh dev set labelled the blind way Vision v1's frozen test set was labelled. Labels for evaluation come from AI
agents, not people. Results: [`../results/vision-v2/RESULTS.md`](../results/vision-v2/RESULTS.md).

Where things run:
- **The Mac** holds the OpenAI key and sends the calls (`openai_label.py`). It pulls request bodies from the data node
  in batches over ssh, keeps only random tokens and probability vectors, and deletes each batch's requests (they hold
  the crops) once its answers are back on the node.
- **The data node** (c20, Vision v1's data under `~/vision-out/vision-v1`) builds the requests (`oa_requests.py`),
  joins the answers to crop ids, builds the dev set, trains, evaluates and exports. Everything this package writes on
  the node is under `~/vision-out/vision-v2`.
- **Labeller agents** see only the blind sheets of their own chunk and `LABELLING.md`, in a private scratch folder on
  the Mac that is deleted after the pass.

## Pieces

| file | what |
|---|---|
| `common.py`, `clef_prompt.py`, `metrics.py` | copied from vision_v1: paths, crop geometry, letterbox, the 64 facts; Clef's prompt text; the Clef evaluation's metrics |
| `luna_prompt.py` | the Decisions request of `vision/openai_decisions/eval.py` for `luna-img-p3`; its state text is `clef-img-p3`'s, checked character for character |
| `oa_requests.py` | node side: batches of request bodies under random tokens (`secrets.token_hex`), the token key, answers joined to crop ids |
| `openai_label.py` | Mac side: calls with kept-alive connections, backoff, a spend cap from each response's `usage.input_tokens` |
| `clef_answers.py` | readers of Clef's cached answers (Vision v1) and OpenAI's answers |
| `devset.py`, `LABELLING.md` | the fresh dev set: hosts, strata like the test, blind sheets, chunks per labeller agent, adjudication, resolution, digests |
| `train.py` | the student: verdict head (OpenAI), family head (OpenAI, or OpenAI and Clef averaged), optional any-problem head |
| `evaluate.py` | model choice on the fresh dev set, dev thresholds, a dry run, and the one evaluation on the frozen test set (refuses a second run) |
| `export.py`, `portable/score_onnx.py`, `port_check.py` | ONNX fp32, `spec.json`, a self-contained scorer, parity in a clean environment |
| `report.py` | markdown tables from the evaluation JSONs |
| `run_quarter.sh` | one detached, CPU-pinned training run per slot of an 80-vCPU node |

## Run

```
# node: code in ~/vv2-code, Vision v1's venv (torch 2.14.1 cpu, torchvision, onnxruntime, Pillow)
python oa_requests.py plan
# Mac: the key never leaves it
python3 openai_label.py pilot --node $IP --work $WORK --n 20
python3 openai_label.py run --node $IP --work $WORK --concurrency 24 --cap-usd 24
# node
python oa_requests.py collect
python devset.py hosts && python devset.py build && python devset.py digest
python devset.py chunks --pass A --chunks 3 && python devset.py chunks --pass B --chunks 3   # to the labeller agents
python devset.py adjudicate && python devset.py chunks --pass C --chunks 1
python devset.py resolve && python devset.py labeldigest
SLOTS=8 bash run_quarter.sh 0 L5 --fam-target luna --epochs 12 --lr 5e-3 --lr-backbone 2e-3   # and the other runs
python evaluate.py select
python evaluate.py dev --model ~/vision-out/vision-v2/models/<run> --score <score>
python evaluate.py final --model ... --score ... --dry       # the code path on shuffled dev labels
python evaluate.py final --model ... --score ...             # once
python export.py --model ... --score ... --dev ~/vision-out/vision-v2/eval/dev.json
python port_check.py prepare --model ... --score ... --dir /tmp/vv2-port   # then score_onnx.py in a clean venv
python port_check.py compare --model ... --score ... --dir /tmp/vv2-port
python report.py --eval ~/vision-out/vision-v2/eval
```
