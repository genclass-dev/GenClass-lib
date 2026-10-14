"""Export a LightGBM model to a compact JSON tree format (read by gbt.mjs) and to ONNX, and check both against
LightGBM's own predictions.

    ~/vt-venv/bin/python vision/train/export.py --model ~/vision-out/models/model-gbt-small.txt --out ~/vision-out/export

Compact format, version 1:
  {"format": "genclass-gbt-1", "inputs": [names], "base": 0, "trees": [[f, t, l, r, ...], ...], "leaves": [[...], ...]}
Each tree is a flat array of 4-tuples, one per internal node: f, t, left, right. A numeric split has f >= 0 (the
input index) and goes left when x[f] <= t (t is LightGBM's double threshold). A categorical split has f < 0: the
input is -1 - f, t indexes "cats", and it goes left when the input is a whole number in cats[t]. A child >= 0 is
another node; a negative child -1 - j is leaf j of that tree's "leaves" array.
score = sigmoid(base + sum of one leaf per tree). Inputs never hold NaN (the extractor fills defaults), so
LightGBM's missing-value branches are not encoded; export checks that no split relies on them.
Also writes sample-X.f32 / sample-p.f32 (rows from the test split and LightGBM's scores) for the JS parity check.
"""

import argparse
import json
import os
import time

import lightgbm as lgb
import numpy as np

from common import Cols, Split, load_schema, log, model_inputs


def compact(bst):
    d = bst.dump_model()
    names = d["feature_names"]
    cats, cat_ix = [], {}
    trees, leaves = [], []
    for t in d["tree_info"]:
        nodes, lv = [], []

        def walk(n):
            if "leaf_value" in n:
                lv.append(round(n["leaf_value"], 7))
                return -len(lv)  # -1 - j with j = len(lv) - 1
            # Zero-as-missing would send values near 0 to the default side; the inputs have no NaN, so None and NaN
            # missing types behave as plain comparisons
            assert n.get("missing_type", "None") in ("None", "NaN"), n.get("missing_type")
            k = len(nodes) // 4
            nodes.extend([n["split_feature"], 0, 0, 0])
            if n["decision_type"] == "==":
                key = tuple(sorted(int(c) for c in str(n["threshold"]).split("||")))
                if key not in cat_ix:
                    cat_ix[key] = len(cats)
                    cats.append(list(key))
                nodes[4 * k] = -1 - n["split_feature"]
                nodes[4 * k + 1] = cat_ix[key]
            else:
                assert n["decision_type"] == "<=", n["decision_type"]
                nodes[4 * k + 1] = float(n["threshold"])
            nodes[4 * k + 2] = walk(n["left_child"])
            nodes[4 * k + 3] = walk(n["right_child"])
            return k

        root = walk(t["tree_structure"])
        if root < 0:  # a single-leaf tree
            nodes = [0, 1e300, -1, -1]
        trees.append(nodes)
        leaves.append(lv)
    return {"format": "genclass-gbt-1", "inputs": names, "base": 0, "cats": cats, "trees": trees, "leaves": leaves}


def score_compact(m, X):
    out = np.zeros(X.shape[0])
    for r in range(X.shape[0]):
        x = X[r]
        s = m["base"]
        for nodes, lv in zip(m["trees"], m["leaves"]):
            k = 0
            while True:
                f, t, l, rr = nodes[4 * k:4 * k + 4]
                if f < 0:
                    v = x[-1 - f]
                    go = v >= 0 and float(v).is_integer() and int(v) in m["_catsets"][t]
                else:
                    go = x[f] <= t
                k = l if go else rr
                if k < 0:
                    s += lv[-1 - k]
                    break
        out[r] = 1 / (1 + np.exp(-s))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/trainset"))
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", default=os.path.expanduser("~/vision-out/export"))
    ap.add_argument("--sample", type=int, default=20000)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    stem = os.path.basename(a.model).replace("model-", "").replace(".txt", "")
    bst = lgb.Booster(model_file=a.model)
    schema = load_schema(a.set)
    cols = Cols(schema)
    te = Split(a.set, "test", schema)
    rng = np.random.default_rng(3)
    idx = np.sort(rng.choice(len(te.y), a.sample, replace=False))
    X, names = model_inputs(te.X[idx], cols)
    assert names == bst.feature_name(), "input names differ from the model's"
    X = X.astype(np.float32)
    p = bst.predict(X)
    rep = {"model": a.model, "trees": bst.num_trees(), "sampleRows": int(a.sample)}

    # compact JSON
    m = compact(bst)
    path = os.path.join(a.out, f"{stem}.json")
    js = json.dumps(m, separators=(",", ":"))
    open(path, "w").write(js)
    import gzip
    rep["json"] = {"path": path, "bytes": len(js), "gzipBytes": len(gzip.compress(js.encode(), 9)),
                   "nodes": sum(len(t) // 4 for t in m["trees"]), "leaves": sum(len(lv) for lv in m["leaves"])}
    m["_catsets"] = [set(c) for c in m["cats"]]
    n = min(2000, len(X))
    pc = score_compact(m, X[:n].astype(np.float64))
    rep["json"]["maxAbsDiffPython"] = float(np.abs(pc - p[:n]).max())
    log(f"compact JSON {rep['json']}")

    # ONNX
    try:
        import onnxmltools
        from onnxmltools.convert.common.data_types import FloatTensorType
        import onnxruntime as ort
        onx = onnxmltools.convert_lightgbm(bst, initial_types=[("input", FloatTensorType([None, X.shape[1]]))], zipmap=False,
                                           target_opset=15)
        opath = os.path.join(a.out, f"{stem}.onnx")
        open(opath, "wb").write(onx.SerializeToString())
        so = ort.SessionOptions()
        so.intra_op_num_threads = 1
        sess = ort.InferenceSession(opath, so, providers=["CPUExecutionProvider"])
        outs = sess.run(None, {"input": X})
        po = outs[1][:, 1] if outs[1].ndim == 2 else outs[1]
        t = time.time()
        for b in range(0, len(X), 1):
            if b >= 2000:
                break
            sess.run(None, {"input": X[b:b + 1]})
        one = (time.time() - t) / min(2000, len(X))
        t = time.time()
        sess.run(None, {"input": X})
        batch = (time.time() - t) / len(X)
        rep["onnx"] = {"path": opath, "bytes": os.path.getsize(opath), "maxAbsDiffLightGBM": float(np.abs(po - p).max()),
                       "secondsPerRowSingle": one, "secondsPerRowBatch": batch, "threads": 1}
        log(f"onnx {rep['onnx']}")
    except Exception as e:  # recorded, not fatal: the JSON export is the runtime format
        rep["onnx"] = {"error": f"{type(e).__name__}: {e}"[:500]}
        log(f"onnx failed: {rep['onnx']}")

    t = time.time()
    bst.predict(X, num_threads=1)
    rep["lightgbmSecondsPerRowBatch1Thread"] = (time.time() - t) / len(X)
    X.tofile(os.path.join(a.out, f"sample-X-{stem}.f32"))
    p.astype(np.float64).tofile(os.path.join(a.out, f"sample-p-{stem}.f64"))
    json.dump(rep, open(os.path.join(a.out, f"export-{stem}.json"), "w"), indent=1)
    log("done")


if __name__ == "__main__":
    main()
