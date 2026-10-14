#!/usr/bin/env python3
# Exports the Vision v2 student to ONNX (fp32) with everything needed to score it elsewhere: model.onnx, spec.json
# (input layout, letterbox, the 64 measured facts in order, output classes, the any-problem score, the fresh-dev
# thresholds) and score_onnx.py (portable/, numpy + Pillow + onnxruntime only). Measures size, CPU latency and parity
# with PyTorch. (Vision v1's dynamic int8 export was off by up to 0.56 and slower, so v2 ships fp32 only.)
#
#   export.py --model DIR --score notFine|anyH [--dev OUT/eval/dev.json]

import argparse
import json
import os
import shutil
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import IN_W, IN_H, MAX_UPSCALE, LETTERBOX_FILL, PAD, FAMILIES, VERDICTS, FACT_NAMES, TEXT_TAGS  # noqa: E402
from train import Student, load_pack  # noqa: E402


class Export(torch.nn.Module):
    """image (N, 3, H, W) RGB 0..255, facts (N, 64) -> family (N, 11), any (N), verdict (N, 8) probabilities."""

    def __init__(self, m, score):
        super().__init__()
        self.m = m
        self.score = score

    def forward(self, image, facts):
        r = self.m(image, facts)
        fam, ver = torch.softmax(r[0], 1), torch.softmax(r[1], 1)
        anyp = torch.sigmoid(r[2]) if self.score == "anyH" else 1 - ver[:, 0]
        return fam, anyp, ver


def latency(sess, x, f, n=300):
    feeds = {"image": x, "facts": f}
    for _ in range(20):
        sess.run(None, feeds)
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        sess.run(None, feeds)
        ts.append((time.perf_counter() - t0) * 1000)
    return {"medianMs": round(float(np.median(ts)), 3), "p95Ms": round(float(np.percentile(ts, 95)), 3)}


def main():
    import onnxruntime as ort
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--score", required=True, choices=["notFine", "anyH"])
    ap.add_argument("--dev", default="")
    a = ap.parse_args()
    ed = os.path.join(a.model, "export")
    os.makedirs(ed, exist_ok=True)
    ck = torch.load(os.path.join(a.model, "model.pt"), map_location="cpu")
    if list(ck.get("input", [IN_W, IN_H])) != [IN_W, IN_H]:
        sys.exit("the model was trained at %s; set VV1_INPUT to match" % ck["input"])
    m = Student(ck["arch"], pretrained=False, any_head=ck.get("anyHead", False))
    m.load_state_dict(ck["state"])
    m.eval()
    ex = Export(m, a.score).eval()
    x0 = torch.full((1, 3, IN_H, IN_W), 128.0)
    f0 = torch.zeros(1, len(FACT_NAMES))
    p32 = os.path.join(ed, "model.onnx")
    torch.onnx.export(ex, (x0, f0), p32, input_names=["image", "facts"], output_names=["family", "any", "verdict"],
                      dynamic_axes={"image": {0: "n"}, "facts": {0: "n"}, "family": {0: "n"}, "any": {0: "n"}, "verdict": {0: "n"}},
                      opset_version=17, dynamo=False)
    items, X, _, F = load_pack("lab")
    k = np.arange(0, len(items), max(1, len(items) // 128))[:128]
    xs = torch.from_numpy(np.asarray(X[k])).permute(0, 3, 1, 2).float().contiguous()
    fs = torch.from_numpy(np.asarray(F[k]))
    with torch.no_grad():
        tf, ta, tv = ex(xs, fs)
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    s32 = ort.InferenceSession(p32, so, providers=["CPUExecutionProvider"])
    of, oa, ov = s32.run(None, {"image": xs.numpy(), "facts": fs.numpy()})
    x1, f1 = xs[:1].numpy(), fs[:1].numpy()
    torch.set_num_threads(1)
    with torch.no_grad():
        for _ in range(10):
            ex(xs[:1], fs[:1])
        ts = []
        for _ in range(100):
            t0 = time.perf_counter()
            ex(xs[:1], fs[:1])
            ts.append((time.perf_counter() - t0) * 1000)
    th = {}
    if a.dev and os.path.exists(a.dev):
        d = json.load(open(a.dev))
        th = {k2.replace("v2:", "", 1) if k2.startswith("v2:") else k2: v for k2, v in d["thresholds"].items()
              if (k2.startswith("v2:") or k2.startswith("rules+v2:") or k2 == "secondStage:v2") and v is not None}
    spec = {
        "name": "genclass-vision-v2", "arch": ck["arch"], "epoch": ck.get("epoch"), "familyTarget": ck.get("famTarget"),
        "inputs": {
            "image": {"shape": ["n", 3, IN_H, IN_W], "dtype": "float32", "range": "RGB 0..255, no normalisation (the model normalises)",
                      "crop": "the element's border box plus %d CSS px on each side, clipped to the viewport, at CSS-pixel resolution" % PAD,
                      "letterbox": {"width": IN_W, "height": IN_H, "scale": "min(W / w, H / h, %.1f)" % MAX_UPSCALE,
                                    "resample": "bicubic when scaling up, bilinear when scaling down", "fill": list(LETTERBOX_FILL),
                                    "placement": "centred, offsets floor((W - w') / 2), floor((H - h') / 2)"}},
            "facts": {"shape": ["n", len(FACT_NAMES)], "dtype": "float32", "names": FACT_NAMES,
                      "reference": "score_onnx.py facts() (identical to vision/vision_v2/common.py facts(), unchanged since Vision v1)",
                      "source": "one element row of vision/src/extract.js, its view's page record and the crop geometry",
                      "tagGroups": {"tagImg": ["img"], "tagSvg": ["svg", "path", "use", "g"],
                                    "tagMedia": ["video", "canvas", "iframe", "picture", "object", "embed"], "tagButton": ["button"],
                                    "tagA": ["a"], "tagField": ["input", "select", "textarea"], "tagText": sorted(TEXT_TAGS),
                                    "tagOther": "none of the above"},
                      "clip": [-3, 3]}},
        "outputs": {"family": {"classes": FAMILIES, "what": "the student's family probabilities (taught by OpenAI's family answer%s)" % (
                        " averaged with Clef's" if ck.get("famTarget") == "avg" else "")},
                    "any": {"what": "1 - P(verdict = fine), the student's copy of OpenAI's notFine score" if a.score == "notFine"
                            else "the any-problem head (taught by the mean of OpenAI's notFine and Clef's anyProblem)"},
                    "verdict": {"classes": VERDICTS, "what": "the student's verdict probabilities (taught by OpenAI's verdict answer)"}},
        "thresholdsFromFreshDev": th,
        "labels": "distilled from OpenAI Decisions answers (gpt-6-luna, public beta) on 100,000 natural crops; thresholds and "
                  "evaluation against AI-agent labels (not people)",
    }
    json.dump(spec, open(os.path.join(ed, "spec.json"), "w"), indent=1)
    here = os.path.dirname(os.path.abspath(__file__))
    shutil.copy(os.path.join(here, "portable", "score_onnx.py"), os.path.join(ed, "score_onnx.py"))
    rep = {"sizeBytes": {"onnxFp32": os.path.getsize(p32), "params": int(sum(p.numel() for p in m.parameters()))},
           "parity": {"fp32MaxAbsAny": float(np.abs(oa - ta.numpy()).max()), "fp32MaxAbsFamily": float(np.abs(of - tf.numpy()).max()),
                      "fp32MaxAbsVerdict": float(np.abs(ov - tv.numpy()).max())},
           "latencyOneThreadBatch1": {"onnxFp32": latency(s32, x1, f1),
                                      "torchEager": {"medianMs": round(float(np.median(ts)), 3), "p95Ms": round(float(np.percentile(ts, 95)), 3)}},
           "cpu": open("/proc/cpuinfo").read().split("model name")[1].split("\n")[0].strip(": \t") if os.path.exists("/proc/cpuinfo") else None,
           "onnxruntime": ort.__version__, "torch": torch.__version__}
    json.dump(rep, open(os.path.join(ed, "export.json"), "w"), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
