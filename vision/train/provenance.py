"""Provenance audit: can a classifier tell clean elements of injected views from elements of natural views?

    ~/vt-venv/bin/python vision/train/provenance.py --set ~/vision-out/trainset --out ~/vision-out/models

If it can, the inputs still encode how a view was made (an injection trace, undo drift, the time since load), and a
fault model would learn that instead of the bugs: v1 did. The training scripts refuse to run unless this audit wrote
OUT/provenance.json with ROC AUC below 0.55 on hosts it never saw (common.require_provenance).

Rows, per split:
  injected (1): every `clean` row, the unlabelled elements of injected views (build_set.mjs already leaves out the
                elements a recipe created);
  natural (0):  for each injected row, one row of the natural view of the same host, device and colour scheme, drawn
                with a seeded RNG (with replacement when that view is small).
Matching on host, device and scheme holds the page and the emulation fixed, so a classifier can only separate the
two classes by what injection changed. The unmatched variant (natural rows of the same hosts, any view) is reported
for reference and does not gate.

Inputs: common.model_inputs, exactly what the fault classifiers see. Classifier: LightGBM (31 leaves, learning rate
0.05, early stopping on the val split by AUC), trained on the train split; ROC AUC is measured on the val and test
splits (hosts the classifier never saw). pass = max(val AUC, test AUC) < 0.55. The report also lists the inputs by
gain, the single inputs that separate the classes best (rank AUC of the raw value), and the AUC per device and scheme,
which is where to look when it fails.
"""

import argparse
import json
import os
import time

import numpy as np

MAX_AUC = 0.55


def auc_rank(y, s):
    """ROC AUC by ranks (ties get the average rank). y in {0, 1}; None when one class is empty."""
    y = np.asarray(y).astype(bool)
    s = np.asarray(s, dtype=np.float64)
    n1 = int(y.sum())
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return None
    order = np.argsort(s, kind="mergesort")
    ss = s[order]
    ranks = np.empty(len(s), dtype=np.float64)
    # average ranks over runs of equal scores
    bounds = np.flatnonzero(np.diff(ss)) + 1
    starts = np.concatenate([[0], bounds])
    ends = np.concatenate([bounds, [len(ss)]])
    avg = (starts + ends + 1) / 2.0  # 1-based average rank of each run
    ranks[order] = np.repeat(avg, ends - starts)
    return float((ranks[y].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0))


def view_keys(views, nviews):
    """Integer key per view index: (host, device, scheme); -1 for unknown views."""
    ids = {}
    key = np.full(nviews, -1, np.int64)
    for v, info in views.items():
        if v >= nviews:
            continue
        k = (info["host"], info["device"], info["scheme"])
        key[v] = ids.setdefault(k, len(ids))
    return key


def match_natural(pos_key, nat_key, rng):
    """For each positive's key, the index (into nat_key) of a natural row with the same key, drawn uniformly;
    -1 when the key has no natural row."""
    pos_key = np.asarray(pos_key)
    nat_key = np.asarray(nat_key)
    out = np.full(len(pos_key), -1, np.int64)
    if not len(nat_key) or not len(pos_key):
        return out
    order = np.argsort(nat_key, kind="stable")
    sk = nat_key[order]
    lo = np.searchsorted(sk, pos_key, "left")
    hi = np.searchsorted(sk, pos_key, "right")
    n = hi - lo
    ok = (n > 0) & (pos_key >= 0)
    off = np.floor(rng.random(int(ok.sum())) * n[ok]).astype(np.int64)
    out[ok] = order[lo[ok] + off]
    return out


def pairs(S, key, rng, cap, Y_CODES):
    """Row indices (into S) and labels: the injected clean rows (at most `cap`) and, for each, a natural row whose
    view has the same key (host, device and scheme for the audit; host only for the unmatched variant)."""
    pos = np.flatnonzero(S.y == Y_CODES["clean"])
    if cap and len(pos) > cap:
        pos = np.sort(rng.choice(pos, cap, replace=False))
    nat = np.flatnonzero(S.y == Y_CODES["nat"])
    m = match_natural(key[S.v[pos]], key[S.v[nat]], rng)
    keep = m >= 0
    pos, negs = pos[keep], nat[m[keep]]
    idx = np.concatenate([pos, negs])
    y = np.concatenate([np.ones(len(pos), np.int8), np.zeros(len(negs), np.int8)])
    return idx, y


def main():
    import lightgbm as lgb

    from common import Cols, Split, Y_CODES, load_schema, load_views, log, model_inputs

    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/trainset"))
    ap.add_argument("--out", default=os.path.expanduser("~/vision-out/models"))
    ap.add_argument("--cap", type=int, default=400000, help="injected rows per split at most")
    ap.add_argument("--seed", type=int, default=13)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    schema = load_schema(a.set)
    cols = Cols(schema)
    views = load_views(a.set)
    nviews = max(views) + 1
    key = view_keys(views, nviews)
    hkeys = {}
    hkey = np.full(nviews, -1, np.int64)
    for v, info in views.items():
        hkey[v] = hkeys.setdefault(info["host"], len(hkeys))
    rng = np.random.default_rng(a.seed)
    t0 = time.time()
    data = {}
    for name in ("train", "val", "test"):
        S = Split(a.set, name, schema)
        idx, y = pairs(S, key, rng, a.cap, Y_CODES)
        X, names = model_inputs(S.X[idx], cols)
        uidx, uy = pairs(S, hkey, rng, a.cap, Y_CODES)
        UX, _ = model_inputs(S.X[uidx], cols)
        dev = np.array([views[int(v)]["device"] + "-" + views[int(v)]["scheme"] for v in S.v[idx]])
        # the injected view of each pair (both rows of a pair carry it), for the AUC per recipe
        half = len(idx) // 2
        pview = np.concatenate([S.v[idx[:half]], S.v[idx[:half]]])
        data[name] = dict(X=X, y=y, UX=UX, uy=uy, dev=dev, pview=pview, hosts=len(np.unique(hkey[S.v[idx]])))
        log(f"{name}: {int(y.sum())} injected rows, {int((y == 0).sum())} matched natural rows, {data[name]['hosts']} hosts")
        del S
    cat = [k for k, n in enumerate(names) if n.startswith("cat_")]
    params = dict(objective="binary", metric="auc", num_leaves=31, learning_rate=0.05, min_data_in_leaf=100,
                  feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, num_threads=os.cpu_count(),
                  seed=a.seed, verbose=-1, cat_smooth=10, max_cat_to_onehot=8)
    report = {"what": "clean elements of injected views (1) against natural elements of the same host, device and scheme (0)",
              "maxAuc": MAX_AUC, "inputs": names, "seed": a.seed, "cap": a.cap, "params": params}
    for variant, Xk, yk in (("matched", "X", "y"), ("unmatched", "UX", "uy")):
        dtr = lgb.Dataset(data["train"][Xk], data["train"][yk], feature_name=names, categorical_feature=cat, free_raw_data=False)
        dva = lgb.Dataset(data["val"][Xk], data["val"][yk], reference=dtr, feature_name=names, categorical_feature=cat, free_raw_data=False)
        bst = lgb.train(params, dtr, num_boost_round=1000, valid_sets=[dva], valid_names=["val"],
                        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(100)])
        res = {"trees": bst.best_iteration}
        for name in ("val", "test"):
            p = bst.predict(data[name][Xk], num_iteration=bst.best_iteration)
            if variant == "matched":
                report.setdefault("_p", {})[name] = p
            res[f"auc-{name}"] = auc_rank(data[name][yk], p)
            res[f"rows-{name}"] = int(len(p))
            if variant == "matched":
                res[f"byView-{name}"] = {d: auc_rank(data[name][yk][data[name]["dev"] == d], p[data[name]["dev"] == d])
                                         for d in sorted(set(data[name]["dev"].tolist()))}
        imp = bst.feature_importance("gain", iteration=bst.best_iteration)
        tot = float(imp.sum()) or 1.0
        res["topGain"] = [[n, round(g / tot, 4)] for n, g in sorted(zip(names, imp.tolist()), key=lambda z: -z[1])[:20]]
        report[variant] = res
        log(f"{variant}: AUC val {res['auc-val']}, test {res['auc-test']}, {res['trees']} trees")
    # single inputs: rank AUC of the raw value on val+test, folded so 0.5 is no signal
    Xe = np.concatenate([data["val"]["X"], data["test"]["X"]])
    ye = np.concatenate([data["val"]["y"], data["test"]["y"]])
    single = []
    for k, n in enumerate(names):
        u = auc_rank(ye, Xe[:, k])
        if u is not None:
            single.append([n, round(max(u, 1 - u), 4)])
    report["singleInputs"] = sorted(single, key=lambda z: -z[1])[:15]
    # AUC per applied recipe on val+test: the pairs whose injected view applied that recipe (with the matched model's
    # scores), so a recipe whose clean rows give the view away stands out; at least 300 pairs
    rec_auc = []
    pv_e = np.concatenate([data["val"]["pview"], data["test"]["pview"]])
    p_e = np.concatenate([report["_p"]["val"], report["_p"]["test"]])
    by, solo = {}, {}
    for k, v in enumerate(pv_e.tolist()):
        ap = views[int(v)]["applied"]
        for r in ap:
            by.setdefault(r["id"], []).append(k)
        if len(ap) == 1:
            solo.setdefault(ap[0]["id"], []).append(k)
    for rid, ks in by.items():
        if len(ks) >= 600:
            ks = np.asarray(ks)
            u = auc_rank(ye[ks], p_e[ks])
            if u is not None:
                rec_auc.append([rid, round(u, 4), int(len(ks) // 2)])
    report["byRecipe"] = sorted(rec_auc, key=lambda z: -z[1])[:25]
    # the same over views where the recipe was the only one applied (no co-applied recipe to share the blame)
    solo_auc = []
    for rid, ks in solo.items():
        if len(ks) >= 200:
            ks = np.asarray(ks)
            u = auc_rank(ye[ks], p_e[ks])
            if u is not None:
                solo_auc.append([rid, round(u, 4), int(len(ks) // 2)])
    report["byRecipeSolo"] = sorted(solo_auc, key=lambda z: -z[1])
    del report["_p"]
    m = report["matched"]
    report["auc"] = max(x for x in (m["auc-val"], m["auc-test"]) if x is not None)
    report["pass"] = bool(report["auc"] < MAX_AUC)
    report["hosts"] = {n: data[n]["hosts"] for n in data}
    report["seconds"] = round(time.time() - t0)
    json.dump(report, open(os.path.join(a.out, "provenance.json"), "w"), indent=1)
    log(f"provenance: ROC AUC {report['auc']:.4f} ({'pass' if report['pass'] else 'FAIL'}, threshold {MAX_AUC})")
    if not report["pass"]:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
