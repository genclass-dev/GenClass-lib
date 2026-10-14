#!/usr/bin/env python3
# Portability check of the export: prepares a folder with only the exported files and a sample of dev crops, so the
# scorer can run in a clean environment (numpy, Pillow, onnxruntime; no torch, no code from this package), then
# compares its scores with the PyTorch model's.
#
#   port_check.py prepare --model DIR --dir /tmp/vv1-port [--n 300]
#   (clean venv)  cd /tmp/vv1-port && python -I score_onnx.py --model model.onnx --items items.jsonl --out out.jsonl
#   port_check.py compare --model DIR --dir /tmp/vv1-port

import argparse
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT  # noqa: E402


def sample(n):
    items = [json.loads(l) for l in open(os.path.join(OUT, "index", "lab.jsonl"))]
    rows = [k for k, it in enumerate(items) if it["kind"] == "lab"]
    pick = rows[:: max(1, len(rows) // n)][:n]
    return items, pick


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prepare", "compare"])
    ap.add_argument("--model", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--n", type=int, default=300)
    a = ap.parse_args()
    items, pick = sample(a.n)
    ed = os.path.join(a.model, "export")
    if a.cmd == "prepare":
        os.makedirs(a.dir, exist_ok=True)
        for f in ("model.onnx", "model.int8.onnx", "spec.json", "score_onnx.py"):
            shutil.copy(os.path.join(ed, f), os.path.join(a.dir, f))
        with open(os.path.join(a.dir, "items.jsonl"), "w") as out:
            for k in pick:
                it = items[k]
                out.write(json.dumps({"id": str(k), "img": it["img"], "el": it["el"], "page": it["page"], "device": it["device"],
                                      "scheme": it["scheme"], "kids": it["kids"], "crop": it["crop"]}) + "\n")
        print("prepared %d items in %s" % (len(pick), a.dir))
        return
    import torch
    from evaluate import student_scores
    torch.set_num_threads(8)
    lab_rows = [k for k, it in enumerate(items) if it["kind"] == "lab"]
    # pack rows of lab.jsonl are the line numbers (pack.py keeps the order)
    ref = student_scores(a.model, "lab", pick, "full")
    res = {}
    for name in ("out.jsonl", "out-int8.jsonl"):
        p = os.path.join(a.dir, name)
        if not os.path.exists(p):
            continue
        got = {r["id"]: r for r in (json.loads(l) for l in open(p))}
        anyp = np.array([got[str(k)]["any"] for k in pick])
        fam = np.array([got[str(k)]["family"] for k in pick])
        res[name] = {"n": len(pick), "maxAbsAny": float(np.abs(anyp - ref["any"]).max()), "meanAbsAny": float(np.abs(anyp - ref["any"]).mean()),
                     "maxAbsFamily": float(np.abs(fam - ref["fam"]).max()),
                     "rankCorrAny": float(np.corrcoef(np.argsort(np.argsort(anyp)), np.argsort(np.argsort(ref["any"])))[0, 1])}
    json.dump(res, open(os.path.join(ed, "portability.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
