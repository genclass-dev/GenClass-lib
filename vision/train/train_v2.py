"""v2 fault models: one LightGBM model per family, trained on injected faults the pixel check saw change at rest and on
labelled real bugs, against matched clean elements and labelled not-bugs (on the node).

    LD_LIBRARY_PATH=~/vt-venv/gomp ~/vt-venv/bin/python vision/train/train_v2.py search --set ~/vision-out/v2/trainset \
        --labels ~/vision-out/v2/labels.json --out ~/vision-out/v2/models/v2 --prov ~/vision-out/v2/models
    ... train_v2.py train   (same flags; reads search.json from --out for the chosen settings)
    ... train_v2.py stack   (the labelled-crop model and the per-family stacks; after train)
    --extra ~/vision-out/v2/labels-extra.json adds resolve.py labels of crops of TRAIN hosts to the training rows only
    (run B in results/v2/TRAINING.md); --narrow searches around the earlier best settings

Rows of one family model F (train split unless said otherwise):
  positives  fault rows of F whose pixel verdict is "seen" and not noisy (the fault changed pixels inside the
             element's box at rest, and the page was not animating); labelled real bugs of F's group (val hosts of
             the training folds) with weight alpha * positives / labelled real bugs
  negatives  m matched clean elements per positive (natural rows no measured signal marks, and unlabelled rows of
             injected views; same tag, role, area band and device as the positive, coarser key when none exists),
             a background sample of natural rows (total weight equal to the matched rows'), control rows (weight 3),
             labelled not-bugs (val hosts of the training folds) with weight beta * positives / labelled not-bugs
  left out   every other fault row (unseen, outside the viewport, noisy or another family), labelled unclear crops
Groups (labellers did not separate them consistently): overflow and responsive; text and dark.

Labelled crops come only from val and test hosts. Test hosts are never read before scoring. Val hosts are cut into
5 folds by host: each fold's crops are scored by a model trained with the other 4 folds' crops (out-of-fold scores
choose the ship threshold and the calibration on dev), and the final model trains with every val crop. Early
stopping reads val rows (seen faults of F against matched and background val rows), not labelled ones.

search: a small random search on the pooled model (all families) scored by the out-of-fold average precision on the
labelled val crops (real against the rest). train: the 13 family models and the pooled model with the chosen
settings, out-of-fold and final, then scores for every val and test row.
"""

import argparse
import hashlib
import json
import os
import sys
import time

import lightgbm as lgb
import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (FAMILIES, Cols, Split, Y_CODES, load_schema, load_views, log, model_inputs,  # noqa: E402
                    require_provenance)

NAT, CLEAN, CTRL, FAULT = (Y_CODES[k] for k in ("nat", "clean", "control", "fault"))
GROUPS = {"overflow": ("overflow", "responsive"), "responsive": ("overflow", "responsive"),
          "text": ("text", "dark"), "dark": ("text", "dark")}
FOLDS = 5


def group(f):
    return GROUPS.get(f, (f,))


def host_fold(host, seed=11):
    return int(hashlib.sha1(f"{seed}|{host}".encode()).hexdigest()[:8], 16) % FOLDS


class Data:
    """The three splits with model inputs, match keys and pools, and the labelled crops."""

    def __init__(self, a):
        self.schema = load_schema(a.set)
        self.cols = Cols(self.schema)
        self.views = load_views(a.set)
        self.S = {s: Split(a.set, s, self.schema) for s in ("train", "val", "test")}
        log("loaded splits " + ", ".join(f"{k} {v.X.shape}" for k, v in self.S.items()))
        self.Xin, self.names = {}, None
        self.key, self.ckey = {}, {}
        for s, S in self.S.items():
            Xi, names = model_inputs(S.X, self.cols)
            self.Xin[s] = Xi
            self.names = names
            self.key[s], self.ckey[s] = self.match_keys(S)
        self.cat = [k for k, n in enumerate(self.names) if n.startswith("cat_")]
        log(f"inputs {len(self.names)}")
        lab = json.load(open(a.labels))["labels"]
        self.lab = {}
        for s in ("val", "test"):
            L = [e for e in lab if e["split"] == s and e["row"] is not None]
            self.lab[s] = {
                "rows": np.array([e["row"] for e in L], np.int64),
                "verdict": np.array([e["verdict"] for e in L]),
                "family": np.array([e["family"] for e in L]),
                "fold": np.array([host_fold(e["host"]) for e in L], np.int8),
                "id": [e["id"] for e in L], "stratum": np.array([e["stratum"] for e in L]),
                "device": np.array([e["device"] for e in L]), "group": np.array([e["group"] for e in L]),
            }
        self.extra = None
        if getattr(a, "extra", ""):
            X = [e for e in json.load(open(a.extra))["labels"] if e["split"] == "train" and e["row"] is not None]
            self.extra = {"rows": np.array([e["row"] for e in X], np.int64), "verdict": np.array([e["verdict"] for e in X]),
                          "family": np.array([e["family"] for e in X])}
            log(f"extra train-host labels: {len(X)} ({int((self.extra['verdict'] == 'real').sum())} real)")
        # validation and test pools are built the same way as train's
        self.pool = {s: self.neg_pool(S) for s, S in self.S.items()}
        self.seen = {s: (S.y == FAULT) & (S.pv == 1) & (S.noisy == 0) for s, S in self.S.items()}

    def match_keys(self, S):
        c = lambda n: self.cols(S.X, n)
        area = np.maximum(c("w"), 0) * np.maximum(c("h"), 0)
        band = np.clip(np.floor(np.log2(area + 1)), 0, 40).astype(np.int64)
        tag = c("cat_tag").astype(np.int64) + 200
        role = c("cat_role").astype(np.int64) + 200
        dev = c("pDesktop").astype(np.int64)
        fine = ((tag * 1000 + role) * 64 + band) * 2 + dev
        coarse = (tag * 64 + band) * 2 + dev
        return fine, coarse

    def neg_pool(self, S):
        return np.flatnonzero(((S.y == NAT) & (S.nb == 0)) | (S.y == CLEAN))


def matched(pos, pool, key, ckey, m, rng):
    """m pool rows per positive with the same fine key, else the same coarse key; drawn with replacement."""
    out = []
    left = pos
    for K in (key, ckey):
        if not len(left):
            break
        order = pool[np.argsort(K[pool], kind="stable")]
        pk = K[order]
        uk, start, cnt = np.unique(pk, return_index=True, return_counts=True)
        kp, cp = np.unique(K[left], return_counts=True)
        j = np.searchsorted(uk, kp)
        j = np.minimum(j, len(uk) - 1)
        ok = uk[j] == kp
        for kk, c, jj, o in zip(kp, cp, j, ok):
            if o:
                out.append(order[start[jj] + rng.integers(0, cnt[jj], c * m)])
        found = set(kp[ok].tolist())
        left = left[~np.isin(K[left], list(found))]
    return (np.concatenate(out) if out else np.zeros(0, np.int64)), int(len(left))


def build(D, fams, cfg, val_folds, rng, split="train"):
    """Training rows of a model for families `fams` (a tuple): (X, y, w, info). val_folds: the folds of val labelled
    crops to add (empty for none)."""
    S = D.S[split]
    famix = [FAMILIES.index(f) for f in fams]
    pos = np.flatnonzero(D.seen[split] & S.fam[:, famix].any(1))
    neg, unmatched = matched(pos, D.pool[split], D.key[split], D.ckey[split], cfg["m"], rng)
    nat_ok = np.flatnonzero((S.y == NAT) & (S.nb == 0))
    bg = rng.choice(nat_ok, min(cfg["bg"], len(nat_ok)), replace=False)
    ctrl = np.flatnonzero(S.y == CTRL)
    idx = np.concatenate([pos, neg, bg, ctrl])
    y = np.concatenate([np.ones(len(pos)), np.zeros(len(neg) + len(bg) + len(ctrl))]).astype(np.float32)
    w_bg = len(neg) / max(len(bg), 1)
    w = np.concatenate([np.ones(len(pos)), np.ones(len(neg)), np.full(len(bg), w_bg), np.full(len(ctrl), 3.0)])
    X = D.Xin[split][idx]
    info = {"positives": int(len(pos)), "matched": int(len(neg)), "unmatchedPositives": unmatched,
            "background": int(len(bg)), "backgroundWeight": round(float(w_bg), 4), "controls": int(len(ctrl))}
    if len(val_folds):
        L = D.lab["val"]
        sel = np.isin(L["fold"], list(val_folds))
        grp = set()
        for f in fams:
            grp |= set(group(f))
        real = sel & (L["verdict"] == "real") & np.isin(L["family"], list(grp))
        notb = sel & (L["verdict"] == "not")
        parts = [(D.Xin["val"], L["rows"][real], L["rows"][notb])]
        if D.extra is not None and split == "train":  # training-only labels of train hosts
            E = D.extra
            er = (E["verdict"] == "real") & np.isin(E["family"], list(grp))
            parts.append((D.Xin["train"], E["rows"][er], E["rows"][E["verdict"] == "not"]))
        nr = sum(len(p[1]) for p in parts)
        nn = sum(len(p[2]) for p in parts)
        wr = cfg["alpha"] * len(pos) / max(nr, 1)
        wn = cfg["beta"] * len(pos) / max(nn, 1)
        for Xs, rr, rn in parts:
            X = np.concatenate([X, Xs[rr], Xs[rn]])
            y = np.concatenate([y, np.ones(len(rr), np.float32), np.zeros(len(rn), np.float32)])
            w = np.concatenate([w, np.full(len(rr), wr), np.full(len(rn), wn)])
        info.update(labelledReal=nr, labelledNot=nn, realWeight=round(wr, 3), notWeight=round(wn, 3),
                    extraReal=int(len(parts[1][1])) if len(parts) > 1 else 0)
    return X, y, w.astype(np.float32), info


def dev_set(D, fams, cfg, rng):
    """Early-stopping rows from val: seen faults of fams against matched and background val rows."""
    return build(D, fams, dict(cfg, bg=max(cfg["bg"] // 8, 20000)), (), rng, split="val")


def params_of(cfg, seed):
    return dict(objective="binary", metric="average_precision", num_threads=os.cpu_count(), seed=seed, verbose=-1,
                num_leaves=cfg["leaves"], learning_rate=cfg["lr"], min_data_in_leaf=cfg["minleaf"],
                feature_fraction=cfg["ff"], bagging_fraction=0.8, bagging_freq=1, lambda_l2=cfg["l2"],
                max_depth=cfg.get("depth", -1), cat_smooth=10, max_cat_to_onehot=8, max_bin=255)


def fit(D, X, y, w, Xd, yd, wd, cfg, seed):
    dtr = lgb.Dataset(X, y, weight=w, feature_name=D.names, categorical_feature=D.cat, free_raw_data=True)
    dva = lgb.Dataset(Xd, yd, weight=wd, reference=dtr, feature_name=D.names, categorical_feature=D.cat)
    bst = lgb.train(params_of(cfg, seed), dtr, num_boost_round=cfg["rounds"], valid_sets=[dva], valid_names=["dev"],
                    callbacks=[lgb.early_stopping(50, verbose=False)])
    return bst


def train_family(D, fams, cfg, seed, with_final=True):
    """Out-of-fold scores on the val labelled crops, and the final model (all val folds' crops)."""
    rng = np.random.default_rng(seed)
    Xd, yd, wd, dinfo = dev_set(D, fams, cfg, rng)
    L = D.lab["val"]
    oof = np.full(len(L["rows"]), np.nan)
    infos, trees = [], []
    for k in range(FOLDS):
        X, y, w, info = build(D, fams, cfg, [f for f in range(FOLDS) if f != k], np.random.default_rng(seed + 1 + k))
        bst = fit(D, X, y, w, Xd, yd, wd, cfg, seed)
        m = L["fold"] == k
        oof[m] = bst.predict(D.Xin["val"][L["rows"][m]], num_iteration=bst.best_iteration)
        infos.append(info)
        trees.append(bst.best_iteration)
    final = None
    if with_final:
        X, y, w, info = build(D, fams, cfg, list(range(FOLDS)), np.random.default_rng(seed + 99))
        final = fit(D, X, y, w, Xd, yd, wd, cfg, seed)
        infos.append(info)
        trees.append(final.best_iteration)
    return oof, final, {"folds": infos, "trees": trees, "dev": dinfo}


def lab_metrics(D, oof, fams):
    """AP and AUC of out-of-fold scores on val labelled crops: real (any family, and the families' group) against
    every other crop."""
    L = D.lab["val"]
    real = L["verdict"] == "real"
    grp = set()
    for f in fams:
        grp |= set(group(f))
    real_g = real & np.isin(L["family"], list(grp))
    out = {"apReal": round(float(average_precision_score(real, oof)), 4),
           "aucReal": round(float(roc_auc_score(real, oof)), 4)}
    if real_g.sum() and real_g.sum() < len(real_g):
        out["apGroup"] = round(float(average_precision_score(real_g, oof)), 4)
    return out


SPACE = dict(leaves=[15, 31, 63, 127], lr=[0.03, 0.05, 0.1], minleaf=[20, 50, 100, 200], ff=[0.6, 0.8, 1.0],
             l2=[0.0, 1.0, 10.0], m=[5, 10, 20], bg=[200000, 400000], alpha=[0.25, 0.5, 1.0, 2.0],
             beta=[0.25, 0.5, 1.0, 2.0])
BASE = dict(leaves=31, lr=0.05, minleaf=50, ff=0.8, l2=1.0, m=10, bg=300000, alpha=0.5, beta=0.5, rounds=2000)


NARROW = dict(leaves=[15, 31], lr=[0.05, 0.1], minleaf=[20, 50], ff=[0.6, 0.8], l2=[0.0, 1.0], m=[10, 20], bg=[400000],
              alpha=[1.0, 2.0, 4.0], beta=[0.25, 0.5, 1.0])


def cmd_search(D, a):
    rng = np.random.default_rng(a.seed)
    space = NARROW if a.narrow else SPACE
    cfgs = [dict(BASE)] if not a.narrow else [dict(leaves=15, lr=0.1, minleaf=20, ff=0.6, l2=0.0, m=20, bg=400000, alpha=2.0,
                                                   beta=0.25, rounds=2000)]
    for _ in range(a.trials - 1):
        c = {k: v[int(rng.integers(len(v)))] for k, v in space.items()}
        c["rounds"] = 2000
        cfgs.append(c)
    res = []
    for t, cfg in enumerate(cfgs):
        t0 = time.time()
        oof, _, info = train_family(D, tuple(FAMILIES), cfg, a.seed, with_final=False)
        m = lab_metrics(D, oof, FAMILIES)
        res.append({"trial": t, "cfg": cfg, "metrics": m, "trees": info["trees"], "seconds": round(time.time() - t0)})
        log(f"trial {t}: {m} trees {info['trees']} {cfg}")
        json.dump({"trials": res}, open(os.path.join(a.out, "search.json"), "w"), indent=1)
    best = max(res, key=lambda r: r["metrics"]["apReal"])
    json.dump({"trials": res, "best": best}, open(os.path.join(a.out, "search.json"), "w"), indent=1)
    log(f"best trial {best['trial']}: {best['metrics']}")


def cmd_train(D, a):
    srch = json.load(open(os.path.join(a.out, "search.json")))
    ranked = sorted(srch["trials"], key=lambda r: -r["metrics"]["apReal"])
    cfgs = {"best": ranked[0]["cfg"]}
    if a.ensemble and len(ranked) > 1:
        cfgs["second"] = ranked[1]["cfg"]
    models = {"any": tuple(FAMILIES)}
    for f in FAMILIES:
        models[f] = (f,)
    rep = {"configs": cfgs, "models": {}}
    L = D.lab["val"]
    for name, fams in models.items():
        for cname, cfg in cfgs.items():
            t0 = time.time()
            oof, final, info = train_family(D, fams, cfg, a.seed)
            tag = f"{name}" if cname == "best" else f"{name}@{cname}"
            final.save_model(os.path.join(a.out, f"model-{tag}.txt"), num_iteration=final.best_iteration)
            np.save(os.path.join(a.out, f"oof-{tag}.npy"), oof.astype(np.float32))
            for s in ("val", "test"):
                p = final.predict(D.Xin[s], num_iteration=final.best_iteration).astype(np.float32)
                np.save(os.path.join(a.out, f"scores-{tag}-{s}.npy"), p)
            imp = final.feature_importance("gain", iteration=final.best_iteration)
            tot = float(imp.sum()) or 1.0
            top = sorted(zip(D.names, (imp / tot).tolist()), key=lambda z: -z[1])[:15]
            rep["models"][tag] = {"families": list(fams), "config": cname, "info": info,
                                  "oofLabelled": lab_metrics(D, oof, fams), "seconds": round(time.time() - t0),
                                  "topGainShare": [[n, round(g, 4)] for n, g in top]}
            log(f"{tag}: {rep['models'][tag]['oofLabelled']} trees {info['trees']} {rep['models'][tag]['seconds']}s")
            json.dump(rep, open(os.path.join(a.out, "train.json"), "w"), indent=1)
    np.save(os.path.join(a.out, "lab-val-fold.npy"), L["fold"])
    log("done")


LAB_CFG = dict(leaves=7, lr=0.05, minleaf=10, ff=0.8, l2=1.0, depth=3, rounds=150)


def rule_bits(D, s):
    from common import RULES, rules
    rb = rules(D.S[s], D.cols, D.views)
    return np.stack([((rb >> k) & 1).astype(np.float32) for k in range(len(RULES))], axis=1), [f"rule_{r.replace('-', '_')}" for r in RULES]


def cmd_stack(D, a):
    """The ensemble candidate: a small model trained only on labelled val crops (real against not; inputs plus the
    rule bits), out-of-fold like the others, then per family a logistic stack of the family model's and this model's
    logits fitted on the out-of-fold val crops (target: real bug of the family's group). Writes oof-, scores- files
    for tags lab and <family>+lab."""
    from sklearn.linear_model import LogisticRegression
    tr = json.load(open(os.path.join(a.out, "train.json")))
    L = D.lab["val"]
    keep = L["verdict"] != "unclear"
    rbv, rnames = rule_bits(D, "val")
    rbt, _ = rule_bits(D, "test")
    Xv = np.concatenate([D.Xin["val"], rbv], axis=1)
    Xt = np.concatenate([D.Xin["test"], rbt], axis=1)
    names = D.names + rnames
    y = (L["verdict"] == "real").astype(np.float32)
    params = dict(objective="binary", num_threads=os.cpu_count(), seed=a.seed, verbose=-1, num_leaves=LAB_CFG["leaves"],
                  learning_rate=LAB_CFG["lr"], min_data_in_leaf=LAB_CFG["minleaf"], feature_fraction=LAB_CFG["ff"],
                  lambda_l2=LAB_CFG["l2"], max_depth=LAB_CFG["depth"], bagging_fraction=0.8, bagging_freq=1,
                  cat_smooth=10, max_cat_to_onehot=8, min_data_per_group=5)
    Xe = np.zeros((0, Xv.shape[1]), np.float32)
    ye = np.zeros(0, np.float32)
    if D.extra is not None:  # training-only labels of train hosts: in every fold's training rows
        rbtr, _ = rule_bits(D, "train")
        E = D.extra
        ke = E["verdict"] != "unclear"
        Xe = np.concatenate([D.Xin["train"][E["rows"][ke]], rbtr[E["rows"][ke]]], axis=1)
        ye = (E["verdict"][ke] == "real").astype(np.float32)
    oof = np.full(len(y), np.nan)
    for k in range(FOLDS):
        trn = keep & (L["fold"] != k)
        d = lgb.Dataset(np.concatenate([Xv[L["rows"][trn]], Xe]), np.concatenate([y[trn], ye]), feature_name=names,
                        categorical_feature=D.cat)
        bst = lgb.train(params, d, num_boost_round=LAB_CFG["rounds"])
        m = L["fold"] == k
        oof[m] = bst.predict(Xv[L["rows"][m]])
    d = lgb.Dataset(np.concatenate([Xv[L["rows"][keep]], Xe]), np.concatenate([y[keep], ye]), feature_name=names,
                    categorical_feature=D.cat)
    lab = lgb.train(params, d, num_boost_round=LAB_CFG["rounds"])
    lab.save_model(os.path.join(a.out, "model-lab.txt"))
    np.save(os.path.join(a.out, "oof-lab.npy"), oof.astype(np.float32))
    sv, st = lab.predict(Xv).astype(np.float32), lab.predict(Xt).astype(np.float32)
    np.save(os.path.join(a.out, "scores-lab-val.npy"), sv)
    np.save(os.path.join(a.out, "scores-lab-test.npy"), st)
    imp = lab.feature_importance("gain")
    top = sorted(zip(names, (imp / max(imp.sum(), 1)).tolist()), key=lambda z: -z[1])[:15]
    rep = tr
    rep["models"]["lab"] = {"families": list(FAMILIES), "config": "lab", "info": {"rows": int(keep.sum()), "real": int(y[keep].sum()),
                                                                                 "extraRows": int(len(ye)), "extraReal": int(ye.sum())},
                            "oofLabelled": lab_metrics(D, oof, FAMILIES), "topGainShare": [[n, round(g, 4)] for n, g in top]}
    log(f"lab: {rep['models']['lab']['oofLabelled']}")
    lg = lambda p: np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    for tag in [t for t in list(tr["models"]) if "@" not in t and t != "lab" and "+" not in t]:
        fams = tr["models"][tag]["families"]
        grp = set()
        for f in fams:
            grp |= set(group(f))
        of = np.load(os.path.join(a.out, f"oof-{tag}.npy")).astype(np.float64)
        yg = ((L["verdict"] == "real") & np.isin(L["family"], list(grp))).astype(int)
        if yg.sum() < 3:
            continue
        Z = np.stack([lg(of), lg(oof)], axis=1)
        lr = LogisticRegression(C=1.0).fit(Z, yg)
        # out-of-fold stacked scores (the stacker refitted without each fold) for the ship threshold on dev
        oof_s = np.zeros(len(yg))
        for k in range(FOLDS):
            m = L["fold"] == k
            if yg[~m].sum() < 2:
                oof_s[m] = lr.predict_proba(Z[m])[:, 1]
                continue
            oof_s[m] = LogisticRegression(C=1.0).fit(Z[~m], yg[~m]).predict_proba(Z[m])[:, 1]
        np.save(os.path.join(a.out, f"oof-{tag}+lab.npy"), oof_s.astype(np.float32))
        for s, ls in (("val", sv), ("test", st)):
            fs = np.load(os.path.join(a.out, f"scores-{tag}-{s}.npy")).astype(np.float64)
            p = lr.predict_proba(np.stack([lg(fs), lg(ls)], axis=1))[:, 1].astype(np.float32)
            np.save(os.path.join(a.out, f"scores-{tag}+lab-{s}.npy"), p)
        rep["models"][f"{tag}+lab"] = {"families": fams, "config": "stack", "coef": lr.coef_[0].tolist(),
                                      "intercept": float(lr.intercept_[0]), "oofLabelled": lab_metrics(D, oof_s, fams)}
        log(f"{tag}+lab: {rep['models'][f'{tag}+lab']['oofLabelled']} coef {lr.coef_[0]}")
    json.dump(rep, open(os.path.join(a.out, "train.json"), "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["search", "train", "stack"])
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/v2/trainset"))
    ap.add_argument("--labels", default=os.path.expanduser("~/vision-out/v2/labels.json"))
    ap.add_argument("--out", default=os.path.expanduser("~/vision-out/v2/models/v2"))
    ap.add_argument("--prov", default=os.path.expanduser("~/vision-out/v2/models"))
    ap.add_argument("--trials", type=int, default=16)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--ensemble", action="store_true", help="also train every model with the second-best settings")
    ap.add_argument("--extra", default="", help="resolve.py output of extra labelled crops of TRAIN hosts (training only)")
    ap.add_argument("--narrow", action="store_true", help="search: sample around the best settings of an earlier search")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    require_provenance(a.prov)
    D = Data(a)
    {"search": cmd_search, "train": cmd_train, "stack": cmd_stack}[a.cmd](D, a)


if __name__ == "__main__":
    main()
