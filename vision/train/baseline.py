"""Sanity baseline on the vision training set: can element rows tell injected faults from clean elements?

Not the shipped check. A gradient-boosted tree classifier (scikit-learn HistGradientBoosting) on the float32
matrices that src/build_set.mjs writes, fault versus everything else, trained on the train split and measured on
the val and test splits (disjoint hosts). Runs on a cluster node with the jev venv (numpy, scikit-learn):

    ~/jev/.venv/bin/python vision/train/baseline.py --set ~/vision-out/trainset --out ~/vision-out/baseline

Columns that encode how a view was made rather than what the page shows are dropped, or the model would learn the
harness: pRound (the injection round), pVw and pVh (recipe envs resize the viewport), pDark (dark recipes force it).
Negatives: control rows (all), clean rows of injected views and natural rows, each sampled. Natural rows are
"mostly negative": some are real bugs, so the share of natural rows flagged is an upper bound on the false
report rate at that threshold.
"""

import argparse
import gzip
import json
import os
import time

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, roc_auc_score, precision_recall_curve

DROP = {"pRound", "pVw", "pVh", "pDark"}


def load(set_dir, split, F):
    X = np.fromfile(os.path.join(set_dir, f"X-{split}.f32"), dtype=np.float32).reshape(-1, F)
    meta = [json.loads(l) for l in gzip.open(os.path.join(set_dir, f"meta-{split}.jsonl.gz"), "rt")]
    assert len(meta) == X.shape[0], (split, len(meta), X.shape)
    return X, meta


def sample(meta, rng, caps):
    y = np.array([m["y"] for m in meta])
    keep = []
    for cls, cap in caps.items():
        idx = np.flatnonzero(y == cls)
        if cap is not None and len(idx) > cap:
            idx = rng.choice(idx, cap, replace=False)
        keep.append(idx)
    return np.sort(np.concatenate(keep))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/trainset"))
    ap.add_argument("--out", default=os.path.expanduser("~/vision-out/baseline"))
    ap.add_argument("--neg", type=int, default=200000, help="clean and natural rows sampled for training, each")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--iters", type=int, default=400)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()
    schema = json.load(open(os.path.join(a.set, "schema.json")))
    F = schema["F"]
    names = schema["features"]
    cols = [i for i, n in enumerate(names) if n not in DROP]
    cat = [names[i].startswith("cat_") for i in cols]
    rng = np.random.default_rng(a.seed)

    Xtr, mtr = load(a.set, "train", F)
    tr = sample(mtr, rng, {"fault": None, "control": None, "clean": a.neg, "nat": a.neg})
    ytr = np.array([mtr[i]["y"] == "fault" for i in tr])
    clf = HistGradientBoostingClassifier(max_iter=a.iters, learning_rate=0.08, max_leaf_nodes=63, min_samples_leaf=40,
                                         categorical_features=cat, early_stopping=True, validation_fraction=0.1,
                                         random_state=a.seed)
    clf.fit(Xtr[tr][:, cols], ytr)
    print(f"[{time.time() - t0:.0f}s] trained on {len(tr)} rows ({ytr.sum()} faults), {clf.n_iter_} iterations", flush=True)
    del Xtr

    report = {"model": "HistGradientBoostingClassifier", "features": len(cols), "dropped": sorted(DROP),
              "train": {"rows": int(len(tr)), "faults": int(ytr.sum()), "iterations": int(clf.n_iter_)}}
    thr90 = None
    for split in ["val", "test"]:
        X, meta = load(a.set, split, F)
        y = np.array([m["y"] for m in meta])
        p = clf.predict_proba(X[:, cols])[:, 1]
        # the measured split: all faults and controls, and the clean rows of injected views (natural rows apart)
        m = y != "nat"
        yt = y[m] == "fault"
        pr, rc, th = precision_recall_curve(yt, p[m])
        if split == "val":
            ok = np.flatnonzero(pr[:-1] >= 0.9)
            thr90 = float(th[ok[0]]) if len(ok) else 0.5
        flag = p >= thr90
        fam_recall = {}
        for fam in sorted({f for mm in meta if mm["y"] == "fault" for f in mm["f"]}):
            idx = [i for i, mm in enumerate(meta) if mm["y"] == "fault" and fam in mm["f"]]
            fam_recall[fam] = round(float(flag[idx].mean()), 3)
        seen = [i for i, mm in enumerate(meta) if mm["y"] == "fault" and mm.get("pv") == "seen"]
        unseen = [i for i, mm in enumerate(meta) if mm["y"] == "fault" and mm.get("pv") in ("unseen", "out")]
        report[split] = {
            "rows": int(len(y)), "faults": int((y == "fault").sum()), "controls": int((y == "control").sum()),
            "clean": int((y == "clean").sum()), "natural": int((y == "nat").sum()),
            "averagePrecision": round(float(average_precision_score(yt, p[m])), 4),
            "rocAuc": round(float(roc_auc_score(yt, p[m])), 4),
            "threshold": round(thr90, 4),
            "atThreshold": {
                "precision": round(float(yt[flag[m]].mean()) if flag[m].any() else 0.0, 4),
                "recall": round(float(flag[y == "fault"].mean()), 4),
                "recallPixelSeen": round(float(flag[seen].mean()), 4) if seen else None,
                "recallNotSeenInViewport": round(float(flag[unseen].mean()), 4) if unseen else None,
                "controlsFlagged": round(float(flag[y == "control"].mean()), 4),
                "cleanFlagged": round(float(flag[y == "clean"].mean()), 5),
                "naturalFlagged": round(float(flag[y == "nat"].mean()), 5),
            },
            "recallByFamily": fam_recall,
        }
        print(f"[{time.time() - t0:.0f}s] {split}: {json.dumps(report[split])}", flush=True)
    report["seconds"] = round(time.time() - t0)
    json.dump(report, open(os.path.join(a.out, "baseline.json"), "w"), indent=1)
    print(json.dumps({k: report[k] for k in ("train", "seconds")}))


if __name__ == "__main__":
    main()
