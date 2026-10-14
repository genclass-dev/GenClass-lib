"""v2 evaluation on test: real pages (labelled crops) first, injected faults second, the measured-threshold rules
alongside (on the node).

    ~/vt-venv/bin/python vision/train/eval_v2.py --set ~/vision-out/v2/trainset --labels ~/vision-out/v2/labels.json \
        --models ~/vision-out/v2/models/v2

Operating points of a model, each chosen on dev (val) and applied unchanged to test:
  frr-0.1%, frr-1%  0.1% and 1% of dev natural elements flagged (every element of a clean dev view)
  ship              the lowest threshold at which at least 60% of the labelled dev crops the out-of-fold models flag
                    are real bugs (unclear counts as not real), with at least 5 such crops; none when no threshold does
Rules have one fixed operating point; a rule speaks for its family (candidates.mjs RULE_FAMILY).

Real pages (labelled test crops, hosts never used in training): flags = labelled crops at or above the threshold;
precision = real / flags (unclear counts against; "decided" leaves unclear out); recall = labelled real bugs of the
family's group that are flagged. Groups: overflow with responsive, text with dark (labellers did not separate them).
The labelled crops are a stratified sample (800 rule flags, 700 v1-model picks, 700 random, at most 2 per page), so
precision on them is precision among flags that fall on candidates; eval reports how many flags that covers.

SHIP CRITERION: a family ships in the scanner only if, at its ship threshold (chosen on dev), at least 60% of its
flags on labelled test crops are real bugs with at least 10 such flags, and a blind hand check of its other test flags
(handcheck_v2.py) agrees; otherwise the family stays on the measured checks.
"""

import argparse
import json
import math
import os
import sys

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import FAMILIES, RULES, Cols, Split, Y_CODES, load_schema, load_views, log, rules  # noqa: E402

NAT, CLEAN, CTRL, FAULT = (Y_CODES[k] for k in ("nat", "clean", "control", "fault"))
GROUPS = {"overflow": ("overflow", "responsive"), "responsive": ("overflow", "responsive"),
          "text": ("text", "dark"), "dark": ("text", "dark")}
RULE_FAMILY = {
    "image-broken": "media", "media-failed": "media", "text-invisible": "text", "text-template-leak": "leaks",
    "text-placeholder": "media", "css-var-undefined": "styles", "image-distorted": "media", "page-overflow-x": "overflow",
    "font-failed": "text", "pointer-events-leak": "controls", "scroll-lock-stuck": "overflow", "click-blocked": "occlusion",
    "control-unreachable": "occlusion", "dialog-covered": "occlusion",
}
INTERACTION = ("control-unreachable", "click-blocked", "dialog-covered")
SHIP_PRECISION, SHIP_MIN_DEV, SHIP_MIN_TEST = 0.6, 5, 10


def r4(x):
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), 4)


def group(fams):
    g = set()
    for f in fams:
        g |= set(GROUPS.get(f, (f,)))
    return g


def wilson(k, n, z=1.96):
    if n == 0:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 4), round(c + h, 4)]


def lab_block(L, flag, fams):
    """flag: bool per labelled crop. Precision of the flags and recall on labelled real bugs of the group."""
    g = group(fams)
    v = L["verdict"]
    real, unc, notb = flag & (v == "real"), flag & (v == "unclear"), flag & (v == "not")
    n = int(flag.sum())
    rg = (v == "real") & np.isin(L["family"], list(g))
    out = {"flags": n, "real": int(real.sum()), "unclear": int(unc.sum()), "not": int(notb.sum()),
           "precision": r4(real.sum() / n) if n else None, "precisionCI95": wilson(int(real.sum()), n),
           "precisionDecided": r4(real.sum() / (real.sum() + notb.sum())) if (real.sum() + notb.sum()) else None,
           "realOfGroup": int((flag & rg).sum()),
           "precisionGroup": r4((flag & rg).sum() / n) if n else None,
           "groupRealBugs": int(rg.sum()), "recallGroup": r4((flag & rg).sum() / rg.sum()) if rg.sum() else None,
           "allRealBugs": int((v == "real").sum()), "recallAnyReal": r4(real.sum() / (v == "real").sum())}
    out["byStratum"] = {st: {"flags": int((flag & (L["stratum"] == st)).sum()),
                             "real": int((real & (L["stratum"] == st)).sum())} for st in ("rules", "gbt", "random")}
    return out


def inj_block(S, views, flag, fams):
    nat = S.y == NAT
    famix = [FAMILIES.index(f) for f in fams]
    ff = (S.y == FAULT) & S.fam[:, famix].any(1)
    seen = ff & (S.pv == 1) & (S.noisy == 0)
    out = {"frrNatural": r4(flag[nat].mean()), "flaggedNatural": int(flag[nat].sum()),
           "recallSeen": r4(flag[seen].mean()) if seen.any() else None, "seenRows": int(seen.sum()),
           "recallAll": r4(flag[ff].mean()) if ff.any() else None, "faultRows": int(ff.sum()),
           "controlsFlagged": r4(flag[S.y == CTRL].mean()), "cleanFlagged": r4(flag[S.y == CLEAN].mean())}
    nv = np.zeros(int(S.v.max()) + 1, bool)
    has = np.zeros_like(nv)
    np.logical_or.at(has, S.v[nat], True)
    np.logical_or.at(nv, S.v[nat & flag], True)
    out["pageFrr"] = r4(nv[has].mean())
    out["naturalPages"] = int(has.sum())
    return out


def per_family_recall(S, flag):
    res = {}
    for k, f in enumerate(FAMILIES):
        seen = (S.y == FAULT) & S.fam[:, k] & (S.pv == 1) & (S.noisy == 0)
        res[f] = {"seenRows": int(seen.sum()), "recallSeen": r4(flag[seen].mean()) if seen.any() else None}
    return res


def ship_threshold(oof, L):
    """lowest threshold with >= 60% real among the dev crops at or above it and at least SHIP_MIN_DEV of them"""
    order = np.argsort(-oof)
    s = oof[order]
    real = (L["verdict"][order] == "real").astype(float)
    cum = np.cumsum(real)
    best = None
    for j in range(len(s)):
        if j + 1 < len(s) and s[j + 1] == s[j]:
            continue  # take ties together
        n = j + 1
        if n >= SHIP_MIN_DEV and cum[j] / n >= SHIP_PRECISION:
            best = (float(s[j]), n, int(cum[j]))
    return best


def platt(oof, y):
    lo = np.log(np.clip(oof, 1e-6, 1 - 1e-6) / (1 - np.clip(oof, 1e-6, 1 - 1e-6)))
    m = LogisticRegression(C=1.0).fit(lo.reshape(-1, 1), y)
    return float(m.coef_[0][0]), float(m.intercept_[0])


def apply_platt(ab, p):
    lo = np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    return 1 / (1 + np.exp(-(ab[0] * lo + ab[1])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/v2/trainset"))
    ap.add_argument("--labels", default=os.path.expanduser("~/vision-out/v2/labels.json"))
    ap.add_argument("--models", default=os.path.expanduser("~/vision-out/v2/models/v2"))
    ap.add_argument("--tags", default="")
    a = ap.parse_args()
    schema = load_schema(a.set)
    cols = Cols(schema)
    views = load_views(a.set)
    S = {s: Split(a.set, s, schema) for s in ("val", "test")}
    lab = json.load(open(a.labels))
    Lall = lab["labels"]
    L = {}
    for s in ("val", "test"):
        E = [e for e in Lall if e["split"] == s and e["row"] is not None]
        L[s] = {"rows": np.array([e["row"] for e in E]), "verdict": np.array([e["verdict"] for e in E]),
                "family": np.array([e["family"] for e in E]), "stratum": np.array([e["stratum"] for e in E]),
                "device": np.array([e["device"] for e in E]), "group": np.array([e["group"] for e in E])}
    log("loaded")
    tr = json.load(open(os.path.join(a.models, "train.json")))
    out = {"labelled": lab["summary"], "shipCriterion": {"precision": SHIP_PRECISION, "minDevFlags": SHIP_MIN_DEV,
                                                          "minTestFlags": SHIP_MIN_TEST},
           "splits": {}, "rules": {}, "models": {}}
    for s, Sp in S.items():
        out["splits"][s] = {"rows": int(len(Sp.y)), "natural": int((Sp.y == NAT).sum()),
                            "naturalViews": int(len(np.unique(Sp.v[Sp.y == NAT]))),
                            "faults": int((Sp.y == FAULT).sum()),
                            "faultsSeen": int(((Sp.y == FAULT) & (Sp.pv == 1) & (Sp.noisy == 0)).sum()),
                            "hosts": len({views[int(v)]["host"] for v in np.unique(Sp.v)}),
                            "labelled": {k: int((L[s]["verdict"] == k).sum()) for k in ("real", "unclear", "not")}}

    # ---- rules
    rb = {s: rules(S[s], cols, views) for s in S}
    fam_bits = {}
    for f in FAMILIES:
        fam_bits[f] = sum(1 << RULES.index(r) for r, rf in RULE_FAMILY.items() if rf == f)
    inter = sum(1 << RULES.index(r) for r in INTERACTION)
    variants = {"rules": ~0, "rules-core": ~inter}
    for vname, mask in variants.items():
        flag_t = (rb["test"] & mask) != 0
        out["rules"][vname] = {"test": {"injected": inj_block(S["test"], views, flag_t, FAMILIES),
                                        "injectedByFamily": per_family_recall(S["test"], flag_t),
                                        "labelled": lab_block(L["test"], flag_t[L["test"]["rows"]], FAMILIES)}}
    out["rules"]["byFamily"] = {}
    for f in FAMILIES:
        if not fam_bits[f]:
            continue
        for s in ("val", "test"):
            flag = (rb[s] & fam_bits[f]) != 0
            out["rules"]["byFamily"].setdefault(f, {})[s] = {
                "injected": inj_block(S[s], views, flag, (f,)),
                "labelled": lab_block(L[s], flag[L[s]["rows"]], (f,)),
                "rules": [r for r, rf in RULE_FAMILY.items() if rf == f]}
    out["rules"]["perRuleLabelledTest"] = {}
    for k, r in enumerate(RULES):
        flag = ((rb["test"] >> k) & 1) == 1
        out["rules"]["perRuleLabelledTest"][r] = lab_block(L["test"], flag[L["test"]["rows"]], (RULE_FAMILY[r],))
    log("rules done")

    # ---- models
    tags = a.tags.split(",") if a.tags else list(tr["models"].keys())
    for tag in tags:
        p = {s: os.path.join(a.models, f"scores-{tag}-{s}.npy") for s in S}
        if not all(os.path.exists(x) for x in p.values()):
            continue
        fams = tuple(tr["models"][tag]["families"])
        sc = {s: np.load(p[s]) for s in S}
        oof = np.load(os.path.join(a.models, f"oof-{tag}.npy")).astype(np.float64)
        V = S["val"]
        dn = sc["val"][V.y == NAT]
        ops = {"frr-0.1%": float(np.quantile(dn, 0.999)), "frr-1%": float(np.quantile(dn, 0.99))}
        st = ship_threshold(oof, L["val"])
        if st:
            ops["ship"] = st[0]
        yv = (L["val"]["verdict"] == "real").astype(int)
        cal = platt(oof, yv) if 0 < yv.sum() < len(yv) else None
        m = {"families": list(fams), "ops": {}, "shipDev": None if not st else {"threshold": st[0], "flags": st[1], "real": st[2]},
             "oofLabelledVal": {"apReal": r4(average_precision_score(yv, oof)), "aucReal": r4(roc_auc_score(yv, oof))},
             "platt": cal}
        yt = (L["test"]["verdict"] == "real").astype(int)
        st_t = sc["test"][L["test"]["rows"]]
        m["labelledTest"] = {"apReal": r4(average_precision_score(yt, st_t)), "aucReal": r4(roc_auc_score(yt, st_t))}
        g = group(fams)
        ytg = ((L["test"]["verdict"] == "real") & np.isin(L["test"]["family"], list(g))).astype(int)
        if 0 < ytg.sum() < len(ytg):
            m["labelledTest"]["apGroup"] = r4(average_precision_score(ytg, st_t))
            m["labelledTest"]["aucGroup"] = r4(roc_auc_score(ytg, st_t))
        if cal:
            pc = apply_platt(cal, st_t)
            m["labelledTest"]["brierCalibrated"] = r4(np.mean((pc - yt) ** 2))
            m["labelledTest"]["brierBase"] = r4(np.mean((yt.mean() - yt) ** 2))
        for op, thr in ops.items():
            res = {"threshold": thr}
            for s in ("val", "test"):
                flag = sc[s] >= thr
                res[s] = {"injected": inj_block(S[s], views, flag, fams)}
                if s == "test":
                    res[s]["labelled"] = lab_block(L["test"], flag[L["test"]["rows"]], fams)
                    nflag_nat = int((flag & (S[s].y == NAT)).sum())
                    res[s]["labelledCoverage"] = r4(res[s]["labelled"]["flags"] / nflag_nat) if nflag_nat else None
                    if tag == "any":
                        res[s]["injectedByFamily"] = per_family_recall(S[s], flag)
                else:
                    res[s]["labelledOOF"] = lab_block(L["val"], oof >= thr, fams)
            m["ops"][op] = res
        if "ship" in m["ops"]:
            lt = m["ops"]["ship"]["test"]["labelled"]
            m["ships"] = bool(lt["flags"] >= SHIP_MIN_TEST and lt["precision"] is not None and lt["precision"] >= SHIP_PRECISION)
        else:
            m["ships"] = False
        out["models"][tag] = m
        sh = m["ops"].get("ship", {}).get("test", {}).get("labelled", {})
        log(f"{tag}: oof AP {m['oofLabelledVal']['apReal']} test AP {m['labelledTest']['apReal']}; ship dev {m['shipDev']}; "
            f"ship test flags {sh.get('flags')} real {sh.get('real')} prec {sh.get('precision')}; ships {m['ships']}; "
            f"frr-0.1% recallSeen {m['ops']['frr-0.1%']['test']['injected']['recallSeen']} "
            f"frr-1% {m['ops']['frr-1%']['test']['injected']['recallSeen']}")
        json.dump(out, open(os.path.join(a.models, "eval-v2.json"), "w"), indent=1)
    hybrids(a, S, L, views, rb, fam_bits, out)
    json.dump(out, open(os.path.join(a.models, "eval-v2.json"), "w"), indent=1)
    log("wrote eval-v2.json")


def hybrids(a, S, L, views, rb, fam_bits, out):
    """Measured check filtered by a v2 score: a rule flag is kept when the element's score is at least t. For each
    family (and each rule), the score (the family model, its stack, the labelled-crop model, the pooled model or its
    stack) and t are chosen on dev: among the labelled val crops the rule flags, the lowest t whose out-of-fold flags
    are at least 60% real with at least SHIP_MIN_DEV of them, the score that keeps the most real bugs at its t (ties: the
    higher dev precision, then the order family model, its stack, lab, pooled, pooled stack). The
    labelled crops a rule flags are a random sample of that rule's flags (sheets.py strata), so precision on them
    estimates the hybrid's precision on every flag of the rule, unlike a model's own flags."""
    out["hybrid"] = {"families": {}, "rules": {}}
    targets = [("families", f, fam_bits[f], (f,)) for f in FAMILIES if fam_bits[f]]
    targets += [("rules", r, 1 << RULES.index(r), (RULE_FAMILY[r],)) for r in RULES]
    targets += [("families", "any", sum(fam_bits.values()), tuple(FAMILIES))]
    for kind, name, bits, fams in targets:
        rv = (rb["val"] & bits) != 0
        rt = (rb["test"] & bits) != 0
        lv, lt = rv[L["val"]["rows"]], rt[L["test"]["rows"]]
        res = {"rule": {"val": lab_block(L["val"], lv, fams), "test": lab_block(L["test"], lt, fams),
                        "testInjected": inj_block(S["test"], views, rt, fams)}, "candidates": {}}
        best = None
        f0 = fams[0] if len(fams) == 1 else "any"
        for tag in (f0, f"{f0}+lab", "lab", "any", "any+lab"):
            if tag not in out["models"]:
                continue
            oof = np.load(os.path.join(a.models, f"oof-{tag}.npy")).astype(np.float64)
            if lv.sum() < SHIP_MIN_DEV:
                continue
            st = ship_threshold(oof[lv], {"verdict": L["val"]["verdict"][lv]})
            res["candidates"][tag] = None if not st else {"threshold": st[0], "devFlags": st[1], "devReal": st[2]}
            # most real bugs kept on dev, then the higher dev precision, then the order above
            if st and (best is None or (st[2], st[2] / st[1]) > (best[2], best[2] / best[3])):
                best = (tag, st[0], st[2], st[1])
        if best:
            tag, thr = best[0], best[1]
            sv = np.load(os.path.join(a.models, f"scores-{tag}-val.npy"))
            stt = np.load(os.path.join(a.models, f"scores-{tag}-test.npy"))
            oof = np.load(os.path.join(a.models, f"oof-{tag}.npy")).astype(np.float64)
            ht = rt & (stt >= thr)
            lab_t = lab_block(L["test"], ht[L["test"]["rows"]], fams)
            res["chosen"] = {"score": tag, "threshold": thr, "devOOF": lab_block(L["val"], lv & (oof >= thr), fams),
                             "test": lab_t, "testInjected": inj_block(S["test"], views, ht, fams),
                             "devInjected": inj_block(S["val"], views, rv & (sv >= thr), fams)}
            res["ships"] = bool(lab_t["flags"] >= SHIP_MIN_TEST and lab_t["precision"] >= SHIP_PRECISION)
        else:
            res["chosen"] = None
            res["ships"] = False
        out["hybrid"][kind][name] = res
        c = res["chosen"]
        log(f"hybrid {name}: rule test {res['rule']['test']['flags']}/{res['rule']['test']['real']} p {res['rule']['test']['precision']}; "
            + ("no dev threshold" if not c else
               f"{c['score']} t {c['threshold']:.3f}: dev {c['devOOF']['flags']}/{c['devOOF']['real']}, test {c['test']['flags']}/{c['test']['real']} "
               f"p {c['test']['precision']} rG {c['test']['recallGroup']}; ships {res['ships']}"))


if __name__ == "__main__":
    main()
