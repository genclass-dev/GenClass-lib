"""Gradient-boosted trees (LightGBM) on the element rows: fault against everything else.

    ~/vt-venv/bin/python vision/train/train_gbt.py --set ~/vision-out/trainset --out ~/vision-out/models

Writes, in OUT: model-<name>.txt (LightGBM text), scores-<name>-<split>.npy (float32, one per matrix row of the val
and test splits), rules-<split>.npy (the measured-threshold bitmask, common.rules), train-gbt[-seen]-<only or all>.json
(settings, rows, trees, seconds, top inputs by gain). --pos seen trains on pixel-seen fault rows only (gbt-seen).

Training rows (train split only): every fault row, every control row (weight 3: correct lookalikes are the hard
negatives), every clean row of injected views, and a seeded sample of natural rows. Natural rows that a measured
signal marks (schema natBits: broken image, leak pattern, low contrast, placeholder image, undefined var) are left
out of the training negatives, because some of them are real bugs; they stay in every evaluation.
Early stopping reads the val (dev) split; test is never read until scoring.
"""

import argparse
import json
import os
import time

import lightgbm as lgb
import numpy as np

from common import Cols, Split, load_schema, load_views, log, model_inputs, pick, require_provenance, rules, Y_CODES

CONFIGS = {
    # the accuracy model
    "gbt": dict(num_leaves=63, learning_rate=0.05, min_data_in_leaf=40, feature_fraction=0.8, bagging_fraction=0.8,
                bagging_freq=1, lambda_l2=1.0, max_bin=255, rounds=3000, stop=100),
    # the shipping candidate: few shallow trees
    "gbt-small": dict(num_leaves=15, max_depth=6, learning_rate=0.1, min_data_in_leaf=80, feature_fraction=0.8,
                      bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, rounds=600, stop=50),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/trainset"))
    ap.add_argument("--out", default=os.path.expanduser("~/vision-out/models"))
    ap.add_argument("--nat", type=int, default=800000)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--only", default="")
    ap.add_argument("--pos", default="all", choices=["all", "seen"],
                    help="seen: train only on fault rows the pixel check saw change (others left out of training)")
    ap.add_argument("--skip-provenance-gate", action="store_true", help="debug only: results do not count")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    require_provenance(a.out, a.skip_provenance_gate)
    schema = load_schema(a.set)
    cols = Cols(schema)
    views = load_views(a.set)
    rng = np.random.default_rng(a.seed)

    tr = Split(a.set, "train", schema)
    va = Split(a.set, "val", schema)
    log(f"loaded train {tr.X.shape} val {va.X.shape}")
    itr = pick(tr, rng, a.nat)
    iva = pick(va, rng, 200000)
    suffix = ""
    if a.pos == "seen":
        itr = itr[(tr.y[itr] != Y_CODES["fault"]) | (tr.pv[itr] == 1)]
        iva = iva[(va.y[iva] != Y_CODES["fault"]) | (va.pv[iva] == 1)]
        suffix = "-seen"
    Xtr, names = model_inputs(tr.X[itr], cols)
    ytr = (tr.y[itr] == Y_CODES["fault"]).astype(np.float32)
    wtr = np.where(tr.y[itr] == Y_CODES["control"], 3.0, 1.0)
    Xva, _ = model_inputs(va.X[iva], cols)
    yva = (va.y[iva] == Y_CODES["fault"]).astype(np.float32)
    cat = [k for k, n in enumerate(names) if n.startswith("cat_")]
    log(f"train rows {len(itr)} ({int(ytr.sum())} faults), dev rows {len(iva)} ({int(yva.sum())} faults), {len(names)} inputs")
    report = {"inputs": names, "trainRows": int(len(itr)), "trainFaults": int(ytr.sum()), "devRows": int(len(iva)),
              "natSample": a.nat, "seed": a.seed, "pos": a.pos, "models": {}}
    dtr = lgb.Dataset(Xtr, ytr, weight=wtr, feature_name=names, categorical_feature=cat, free_raw_data=False)
    dva = lgb.Dataset(Xva, yva, reference=dtr, feature_name=names, categorical_feature=cat, free_raw_data=False)
    te = None
    for name, cfg in CONFIGS.items():
        if a.only and name not in a.only.split(","):
            continue
        name += suffix
        cfg = dict(cfg)
        rounds, stop = cfg.pop("rounds"), cfg.pop("stop")
        params = dict(objective="binary", metric="average_precision", num_threads=os.cpu_count(), seed=a.seed,
                      verbose=-1, cat_smooth=10, max_cat_to_onehot=8, **cfg)
        t = time.time()
        bst = lgb.train(params, dtr, num_boost_round=rounds, valid_sets=[dva], valid_names=["dev"],
                        callbacks=[lgb.early_stopping(stop, verbose=False), lgb.log_evaluation(100)])
        secs = time.time() - t
        bst.save_model(os.path.join(a.out, f"model-{name}.txt"), num_iteration=bst.best_iteration)
        log(f"{name}: {bst.best_iteration} trees, dev AP {bst.best_score['dev']['average_precision']:.4f}, {secs:.0f}s")
        imp = bst.feature_importance("gain", iteration=bst.best_iteration)
        top = sorted(zip(names, imp.tolist()), key=lambda z: -z[1])[:25]
        report["models"][name] = {"params": params, "trees": bst.best_iteration, "devAP": bst.best_score["dev"]["average_precision"],
                                  "seconds": round(secs), "topGain": [[n, round(g)] for n, g in top]}
        for S in (va, te or Split(a.set, "test", schema)):
            if S.name == "test":
                te = S
            Xs, _ = model_inputs(S.X, cols)
            t = time.time()
            p = bst.predict(Xs, num_iteration=bst.best_iteration).astype(np.float32)
            report["models"][name][f"predictSeconds-{S.name}"] = round(time.time() - t, 2)
            np.save(os.path.join(a.out, f"scores-{name}-{S.name}.npy"), p)
        log(f"{name}: scored val and test")
    for S in (va, te or Split(a.set, "test", schema)):
        np.save(os.path.join(a.out, f"rules-{S.name}.npy"), rules(S, cols, views))
    json.dump(report, open(os.path.join(a.out, f"train-gbt{suffix}-{a.only or 'all'}.json"), "w"), indent=1)
    log("done")


if __name__ == "__main__":
    main()
