#!/usr/bin/env python3
# Exports the Vision v1 student to ONNX with everything needed to score outside the node: model.onnx (fp32) and
# model.int8.onnx (dynamic int8 weights), spec.json (input layout, letterbox, the measured facts in order with the
# tag groups they use, output classes, the any-problem formula, dev thresholds) and portable/score_onnx.py, a
# self-contained scorer (numpy, Pillow, onnxruntime only). Measures size, CPU latency per crop and parity.
#
#   export.py --model DIR [--thresholds DIR/eval-dev-full.json]

import argparse
import json
import os
import shutil
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT, IN_W, IN_H, MAX_UPSCALE, LETTERBOX_FILL, PAD, FAMILIES, VERDICTS, FACT_NAMES, TEXT_TAGS  # noqa: E402
from train import Student, load_pack  # noqa: E402


class Export(torch.nn.Module):
    """image (N, 3, 128, 224) RGB 0..255, facts (N, 64) -> family (N, 11) probabilities, any (N) probability."""

    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, image, facts):
        fa, fb, _, _ = self.m(image, facts)
        pa, pb = torch.softmax(fa, 1), torch.softmax(fb, 1)
        eps = 1e-6
        la = torch.log((1 - pa[:, 0]).clamp(eps, 1 - eps) / pa[:, 0].clamp(eps, 1 - eps))
        lb = torch.log((1 - pb[:, 0]).clamp(eps, 1 - eps) / pb[:, 0].clamp(eps, 1 - eps))
        return (pa + pb) / 2, torch.sigmoid((la + lb) / 2)


def latency(sess, x, f, n=300):
    feeds = {"image": x, "facts": f}
    for _ in range(20):
        sess.run(None, feeds)
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        sess.run(None, feeds)
        ts.append((time.perf_counter() - t0) * 1000)
    return {"medianMs": round(float(np.median(ts)), 2), "p95Ms": round(float(np.percentile(ts, 95)), 2)}


def main():
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic, QuantType
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--thresholds", default="")
    a = ap.parse_args()
    ed = os.path.join(a.model, "export")
    os.makedirs(ed, exist_ok=True)
    ck = torch.load(os.path.join(a.model, "model.pt"), map_location="cpu")
    m = Student(ck["arch"], pretrained=False)
    m.load_state_dict(ck["state"])
    m.eval()
    ex = Export(m).eval()
    x0 = torch.full((1, 3, IN_H, IN_W), 128.0)
    f0 = torch.zeros(1, len(FACT_NAMES))
    p32 = os.path.join(ed, "model.onnx")
    torch.onnx.export(ex, (x0, f0), p32, input_names=["image", "facts"], output_names=["family", "any"],
                      dynamic_axes={"image": {0: "n"}, "facts": {0: "n"}, "family": {0: "n"}, "any": {0: "n"}},
                      opset_version=17, dynamo=False)
    p8 = os.path.join(ed, "model.int8.onnx")
    quantize_dynamic(p32, p8, weight_type=QuantType.QInt8)
    # parity on dev crops (the labelled round-2 crops, full resolution input)
    items, X, _, F = load_pack("lab")
    k = np.arange(0, len(items), max(1, len(items) // 128))[:128]
    xs = torch.from_numpy(np.asarray(X[k])).permute(0, 3, 1, 2).float().contiguous()
    fs = torch.from_numpy(np.asarray(F[k]))
    with torch.no_grad():
        tf, ta = ex(xs, fs)
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    s32 = ort.InferenceSession(p32, so, providers=["CPUExecutionProvider"])
    s8 = ort.InferenceSession(p8, so, providers=["CPUExecutionProvider"])
    of, oa = s32.run(None, {"image": xs.numpy(), "facts": fs.numpy()})
    qf, qa = s8.run(None, {"image": xs.numpy(), "facts": fs.numpy()})
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
    if a.thresholds and os.path.exists(a.thresholds):
        th = {k2: v for k2, v in json.load(open(a.thresholds))["thresholds"].items() if k2.startswith("student:") and v is not None}
    spec = {
        "name": "genclass-vision-v1", "arch": ck["arch"], "epoch": ck.get("epoch"),
        "inputs": {
            "image": {"shape": ["n", 3, IN_H, IN_W], "dtype": "float32", "range": "RGB 0..255, no normalisation (the model normalises)",
                      "crop": "the element's border box plus %d CSS px on each side, clipped to the viewport, at CSS-pixel resolution" % PAD,
                      "letterbox": {"width": IN_W, "height": IN_H, "scale": "min(W / w, H / h, %.1f)" % MAX_UPSCALE,
                                    "resample": "bicubic when scaling up, bilinear when scaling down", "fill": list(LETTERBOX_FILL),
                                    "placement": "centred, offsets floor((W - w') / 2), floor((H - h') / 2)"}},
            "facts": {"shape": ["n", len(FACT_NAMES)], "dtype": "float32", "names": FACT_NAMES,
                      "reference": "portable/score_onnx.py facts() (identical to vision/vision_v1/common.py facts())",
                      "source": "one element row of vision/src/extract.js, its view's page record and the crop geometry",
                      "tagGroups": {"tagImg": ["img"], "tagSvg": ["svg", "path", "use", "g"],
                                    "tagMedia": ["video", "canvas", "iframe", "picture", "object", "embed"], "tagButton": ["button"],
                                    "tagA": ["a"], "tagField": ["input", "select", "textarea"], "tagText": sorted(TEXT_TAGS),
                                    "tagOther": "none of the above"},
                      "clip": [-3, 3]}},
        "outputs": {"family": {"classes": FAMILIES, "what": "mean of the two heads' family probabilities (Clef's family question under its two prompts)"},
                    "any": {"what": "sigmoid of the mean over the two heads of logit(1 - P(none))"}},
        "verdictClasses": VERDICTS,
        "thresholdsFromDev": th,
        "labels": "distilled from Clef answers; evaluated against AI-agent labels (not people)",
    }
    json.dump(spec, open(os.path.join(ed, "spec.json"), "w"), indent=1)
    here = os.path.dirname(os.path.abspath(__file__))
    shutil.copy(os.path.join(here, "portable", "score_onnx.py"), os.path.join(ed, "score_onnx.py"))
    rep = {"sizeBytes": {"onnxFp32": os.path.getsize(p32), "onnxInt8": os.path.getsize(p8),
                         "params": int(sum(p.numel() for p in m.parameters()))},
           "parity": {"fp32MaxAbsAny": float(np.abs(oa - ta.numpy()).max()), "fp32MaxAbsFamily": float(np.abs(of - tf.numpy()).max()),
                      "int8MaxAbsAny": float(np.abs(qa - ta.numpy()).max()), "int8MeanAbsAny": float(np.abs(qa - ta.numpy()).mean())},
           "latencyOneThreadBatch1": {"onnxFp32": latency(s32, x1, f1), "onnxInt8": latency(s8, x1, f1),
                                      "torchEager": {"medianMs": round(float(np.median(ts)), 2), "p95Ms": round(float(np.percentile(ts, 95)), 2)}},
           "cpu": open("/proc/cpuinfo").read().split("model name")[1].split("\n")[0].strip(": \t") if os.path.exists("/proc/cpuinfo") else None,
           "onnxruntime": ort.__version__, "torch": torch.__version__}
    json.dump(rep, open(os.path.join(ed, "export.json"), "w"), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
