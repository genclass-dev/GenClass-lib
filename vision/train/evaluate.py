"""Operating points on dev (val), measured on test, for the measured-threshold rules and the learned models.

    ~/vt-venv/bin/python vision/train/evaluate.py --set ~/vision-out/trainset --models ~/vision-out/models

False-report rate (FRR) is the share of natural elements flagged: elements of clean (not injected) views of the
split's hosts. Some natural elements are real bugs, so FRR is an upper bound; the hand check of a flag sample
(crops.py) estimates how much of it is real. Page FRR is the share of clean views with at least one flag.
Recall is the share of fault rows flagged (all, and those the pixel check saw); page recall is the share of
injected views with at least one fault row in which at least one fault row is flagged.

Operating points, each chosen on dev and applied unchanged to test:
  frr-0.1%, frr-1%     element FRR on dev natural rows
  match-rules         the element FRR the rules reach on dev
  page-5%, page-20%   share of dev clean views with any flag
"""

import argparse
import json
import os

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

from common import Cols, FAMILIES, RULES, PAGE_RULES, Split, Y_CODES, load_schema, load_views, log, page_rules

NAT, CLEAN, CTRL, FAULT = (Y_CODES[k] for k in ("nat", "clean", "control", "fault"))


def r4(x):
    return None if x is None else round(float(x), 4)


def view_max(S, flag_or_score, mask):
    """max over rows in mask, per view index (-inf when the view has no such row)"""
    out = np.full(int(S.v.max()) + 1, -np.inf, np.float64)
    np.maximum.at(out, S.v[mask], flag_or_score[mask].astype(np.float64))
    return out


def measure(S, views, s, thr):
    f = s >= thr
    y = S.y
    nat, fault = y == NAT, y == FAULT
    seen = fault & (S.pv == 1)
    res = {
        "threshold": float(thr),
        "frrNatural": r4(f[nat].mean()), "flaggedNatural": int(f[nat].sum()),
        "cleanFlagged": r4(f[y == CLEAN].mean()), "controlsFlagged": r4(f[y == CTRL].mean()),
        "recall": r4(f[fault].mean()), "recallPixelSeen": r4(f[seen].mean()),
        "recallUnseen": r4(f[fault & (S.pv == 2)].mean()), "recallOutOfViewport": r4(f[fault & (S.pv == 3)].mean()),
        "byFamily": {},
    }
    for k, fam in enumerate(FAMILIES):
        m = fault & S.fam[:, k]
        ms = m & (S.pv == 1)
        res["byFamily"][fam] = {"rows": int(m.sum()), "recall": r4(f[m].mean()) if m.any() else None,
                                "seenRows": int(ms.sum()), "recallSeen": r4(f[ms].mean()) if ms.any() else None}
    # pages
    nv = view_max(S, f, nat)
    natural_views = np.flatnonzero(np.isfinite(nv))
    res["pageFrr"] = r4((nv[natural_views] > 0).mean())
    by = {}
    for v in natural_views:
        vv = views[int(v)]
        key = f"{vv['group']}/{vv['device']}-{vv['scheme']}"
        b = by.setdefault(key, [0, 0])
        b[0] += 1
        b[1] += int(nv[v] > 0)
    res["pageFrrBy"] = {k: {"pages": b[0], "flagged": b[1], "rate": r4(b[1] / b[0])} for k, b in sorted(by.items())}
    fv = view_max(S, f, fault)
    inj = np.flatnonzero(np.isfinite(fv))
    res["pageRecall"] = r4((fv[inj] > 0).mean())
    res["injectedPages"] = int(len(inj))
    res["pageRecallByFamily"] = {}
    for k, fam in enumerate(FAMILIES):
        m = fault & S.fam[:, k]
        fv = view_max(S, f, m)
        vv = np.flatnonzero(np.isfinite(fv))
        res["pageRecallByFamily"][fam] = {"pages": int(len(vv)), "recall": r4((fv[vv] > 0).mean()) if len(vv) else None}
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/trainset"))
    ap.add_argument("--models", default=os.path.expanduser("~/vision-out/models"))
    ap.add_argument("--names", default="gbt,gbt-small,mlp,gbt-seen")
    a = ap.parse_args()
    schema = load_schema(a.set)
    cols = Cols(schema)
    views = load_views(a.set)
    S = {s: Split(a.set, s, schema) for s in ("val", "test")}
    log("loaded")
    out = {"splits": {}, "models": {}}
    for s, Sp in S.items():
        nv = np.unique(Sp.v[Sp.y == NAT])
        out["splits"][s] = {"rows": int(len(Sp.y)), "natural": int((Sp.y == NAT).sum()), "clean": int((Sp.y == CLEAN).sum()),
                            "controls": int((Sp.y == CTRL).sum()), "faults": int((Sp.y == FAULT).sum()),
                            "faultsPixelSeen": int(((Sp.y == FAULT) & (Sp.pv == 1)).sum()),
                            "naturalViews": int(len(nv)), "injectedViewsWithFaultRows": int(len(np.unique(Sp.v[Sp.y == FAULT]))),
                            "hosts": len({views[int(v)]["host"] for v in np.unique(Sp.v)})}

    # ---- rules: one fixed operating point
    rb = {s: np.load(os.path.join(a.models, f"rules-{s}.npy")) for s in S}
    rule_frr_dev = float((rb["val"][S["val"].y == NAT] != 0).mean())
    out["models"]["rules"] = {"dev": measure(S["val"], views, (rb["val"] != 0).astype(np.float32), 0.5),
                              "test": measure(S["test"], views, (rb["test"] != 0).astype(np.float32), 0.5), "perRule": {}}
    T = S["test"]
    for k, name in enumerate(RULES):
        f = (rb["test"] >> k) & 1 == 1
        fam_hits = {fam: int((f & (T.y == FAULT) & T.fam[:, j]).sum()) for j, fam in enumerate(FAMILIES)}
        out["models"]["rules"]["perRule"][name] = {
            "naturalFlagged": int(f[T.y == NAT].sum()), "frrNatural": r4(f[T.y == NAT].mean()),
            "faultRowsFlagged": int(f[T.y == FAULT].sum()), "controlsFlagged": int(f[T.y == CTRL].sum()),
            "byFamily": {k2: v for k2, v in fam_hits.items() if v}}
    # the same without the static stand-ins for the interaction checks (control-unreachable, click-blocked,
    # dialog-covered), which the runtime only runs on a user action with more conditions than a row holds
    inter = sum(1 << RULES.index(r) for r in ("control-unreachable", "click-blocked", "dialog-covered"))
    out["models"]["rules-core"] = {s2: measure(S[s3], views, ((rb[s3] & ~inter) != 0).astype(np.float32), 0.5)
                                   for s2, s3 in (("dev", "val"), ("test", "test"))}
    pr = {s: page_rules(S[s], cols, views) for s in S}
    pt = {}
    for k, name in enumerate(PAGE_RULES):
        nat_views = [v for v in pr["test"] if views[v]["round"] == 0]
        pl = [v for v in pr["test"] if views[v]["round"] > 0 and views[v]["pageLabels"]]
        pt[name] = {"naturalPages": len(nat_views), "naturalFlagged": sum((pr["test"][v] >> k) & 1 for v in nat_views),
                    "pageLabelledInjectedPages": len(pl), "pageLabelledFlagged": sum((pr["test"][v] >> k) & 1 for v in pl)}
    out["models"]["rules"]["pageFactsTest"] = pt
    log(f"rules: dev FRR {rule_frr_dev:.5f}, test recall {out['models']['rules']['test']['recall']}")

    # ---- learned models
    for name in a.names.split(","):
        p = {s: os.path.join(a.models, f"scores-{name}-{s}.npy") for s in S}
        if not all(os.path.exists(x) for x in p.values()):
            continue
        sc = {s: np.load(p[s]) for s in S}
        V = S["val"]
        dn = sc["val"][V.y == NAT]
        ops = {"frr-0.1%": float(np.quantile(dn, 0.999)), "frr-1%": float(np.quantile(dn, 0.99)),
               "match-rules": float(np.quantile(dn, 1 - rule_frr_dev))}
        vmx = view_max(V, sc["val"], V.y == NAT)
        vmx = vmx[np.isfinite(vmx)]
        ops["page-5%"] = float(np.quantile(vmx, 0.95))
        ops["page-20%"] = float(np.quantile(vmx, 0.80))
        m = {"ops": {}}
        for s in S:
            Sp = S[s]
            fl = Sp.y == FAULT
            neg_nat = Sp.y == NAT
            neg_inj = (Sp.y == CLEAN) | (Sp.y == CTRL)
            mm = fl | neg_nat
            m[f"{s}AP_faultVsNatural"] = r4(average_precision_score(fl[mm], sc[s][mm]))
            m[f"{s}AUC_faultVsNatural"] = r4(roc_auc_score(fl[mm], sc[s][mm]))
            mm = fl | neg_inj
            m[f"{s}AP_faultVsCleanControl"] = r4(average_precision_score(fl[mm], sc[s][mm]))
            m[f"{s}AUC_faultVsCleanControl"] = r4(roc_auc_score(fl[mm], sc[s][mm]))
        for op, thr in ops.items():
            m["ops"][op] = {"dev": measure(S["val"], views, sc["val"], thr), "test": measure(S["test"], views, sc["test"], thr)}
        out["models"][name] = m
        log(f"{name}: test AP(nat) {m['testAP_faultVsNatural']}; " + "; ".join(
            f"{op} FRR {v['test']['frrNatural']} recall {v['test']['recall']} pageFRR {v['test']['pageFrr']}" for op, v in m["ops"].items()))
    json.dump(out, open(os.path.join(a.models, "eval.json"), "w"), indent=1)
    log("wrote eval.json")


if __name__ == "__main__":
    main()
