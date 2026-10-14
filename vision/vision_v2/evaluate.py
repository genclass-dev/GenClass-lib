#!/usr/bin/env python3
# Evaluation of Vision v2 (the OpenAI-taught student) next to Vision v1, Clef and OpenAI itself.
#
#   evaluate.py select                         model choice on the fresh dev set: every run's dev AP over its last
#                                              three epochs, per score; the best (run, score) is the model
#   evaluate.py dev   --model DIR --score S    thresholds on the fresh dev set for every detector -> OUT/eval/dev.json
#   evaluate.py final --model DIR --score S    the one evaluation on Vision v1's frozen test set (its second use);
#                                              refuses to run when OUT/eval/test-final.json exists
#   evaluate.py final ... --dry                the same code on a stand-in: the fresh dev crops with shuffled dev
#                                              labels (no test label is read) -> OUT/eval/dry-final.json
#
# Fresh dev = devset.py (600 crops, two blind AI-agent passes + adjudication): model choice and every threshold. Test =
# vision/results/vision-v1/TEST-FROZEN.md (1,300 crops, 507 held-out hosts), used once by Vision v1 and once here;
# nothing in Vision v2 was tuned on it. Unclear counts as not real in every precision; ranking metrics leave unclear
# out. Output files hold aggregates only (no crop ids, no hosts).

import argparse
import glob
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT, V1, FAMILIES, VERDICTS  # noqa: E402
import metrics  # noqa: E402

ED = os.path.join(OUT, "eval")
V1_MODEL = os.path.join(V1, "models", "f-s-lr5")  # Vision v1's chosen model and its dev thresholds
# the v1 rules that look for each family (vision/clef/eval.py FAMILY_RULES, as in vision_v1/evaluate.py)
FAMILY_RULES = {"media": {"image-broken", "image-distorted", "media-failed", "text-placeholder"},
                "overflow": {"page-overflow-x"}, "occlusion": {"control-unreachable", "click-blocked"},
                "dark": {"text-invisible", "css-var-undefined"}, "text": {"text-invisible", "css-var-undefined", "font-failed"},
                "leaks": {"text-template-leak", "text-placeholder"}}
DETECT_FAMS = [f for f in FAMILIES if f != "none"]
JUDGES = ["v2", "v1", "clef", "luna", "ens"]  # ens: OpenAI and Clef averaged (scores and family probabilities)


def lg(p):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def wilson(k, n, z=1.96):
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 3), round(c + h, 3)]


# ---------------------------------------------------------------- scores


def nat_rows(crop_ids):
    from common import PACK_DIR
    nat = json.load(open(os.path.join(PACK_DIR, "nat.json")))["items"]
    row_of = {it["id"]: k for k, it in enumerate(nat)}
    return np.array([row_of[c] for c in crop_ids])


def run_model(m, X, F, rows, bs=256):
    import torch
    rows = np.asarray(rows)
    o = np.argsort(rows)
    srt = rows[o]
    outs = []
    m.eval()
    with torch.no_grad():
        for s in range(0, len(srt), bs):
            x = torch.from_numpy(np.asarray(X[srt[s: s + bs]])).permute(0, 3, 1, 2).float().contiguous(memory_format=torch.channels_last)
            f = torch.from_numpy(np.asarray(F[srt[s: s + bs]]))
            outs.append([z.float().numpy() for z in m(x, f)])
    cat = [np.concatenate([b[i] for b in outs]) for i in range(len(outs[0]))]
    inv = np.empty(len(rows), int)
    inv[o] = np.arange(len(rows))
    return [c[inv] for c in cat]


def softmax(z):
    z = z - z.max(1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(1, keepdims=True)


def v2_scores(model_dir, rows, score, pack="nat", ckpt="model.pt"):
    import torch
    from train import Student, load_pack
    ck = torch.load(os.path.join(model_dir, ckpt), map_location="cpu")
    m = Student(ck["arch"], pretrained=False, any_head=ck.get("anyHead", False))
    m.load_state_dict(ck["state"])
    m = m.to(memory_format=torch.channels_last)
    _, X, _, F = load_pack(pack)
    r = run_model(m, X, F, rows)
    fam, ver = softmax(r[0]), softmax(r[1])
    out = {"fam": fam, "notFine": 1 - ver[:, 0], "anyF": 1 - fam[:, 0]}
    if len(r) > 2:
        out["anyH"] = 1 / (1 + np.exp(-r[2]))
    out["any"] = out[score]
    return out


def v1_scores(rows, pack="nat"):
    """Vision v1's student (f-s-lr5) with its own score formulas: any = sigmoid of the mean over its two family
    heads of logit(1 - P(none)); family = the mean of the two heads' probabilities."""
    import torch
    from train import StudentV1, load_pack
    ck = torch.load(os.path.join(V1_MODEL, "model.pt"), map_location="cpu")
    m = StudentV1(ck["arch"], any_head=ck.get("anyHead", False))
    m.load_state_dict(ck["state"])
    m = m.to(memory_format=torch.channels_last)
    _, X, _, F = load_pack(pack)
    r = run_model(m, X, F, rows)
    pa, pb = softmax(r[0]), softmax(r[1])
    anyp = 1 / (1 + np.exp(-(lg(1 - pa[:, 0]) + lg(1 - pb[:, 0])) / 2))
    return {"fam": (pa + pb) / 2, "any": anyp}


def teacher_scores(crop_ids):
    """Clef (mean of its two prompts' family probabilities; anyProblem = the sum of the two prompts' logits, the
    teacher score of Vision v1), OpenAI (family probabilities; notFine) and their average."""
    from clef_answers import answered, luna
    A, Bv = answered("clef-img-p3"), answered("clef-imgonly-p2")
    L = luna()
    n = len(crop_ids)
    cf, ca = np.full((n, len(FAMILIES)), np.nan), np.full(n, np.nan)
    lf, la = np.full((n, len(FAMILIES)), np.nan), np.full(n, np.nan)
    for k, cid in enumerate(crop_ids):
        ps = [np.array([r[cid]["answers"]["family"]["probabilities"].get(c, 0.0) for c in FAMILIES]) for r in (A, Bv) if cid in r]
        ps = [p / p.sum() for p in ps if p.sum() > 0]
        if ps:
            cf[k] = np.mean(ps, 0)
            ca[k] = float(np.mean([lg(1 - p[0]) for p in ps])) * 2
        r = L.get(cid)
        if r:
            f = np.array([r["family"].get(c, 0.0) for c in FAMILIES])
            lf[k] = f / f.sum()
            v = np.array([r["verdict"].get(c, 0.0) for c in VERDICTS])
            la[k] = 1 - v[0] / v.sum()
    clef_sig = 1 / (1 + np.exp(-ca / 2))  # the mean of the two prompts' logits, as a probability
    return {"clef": {"fam": cf, "any": ca}, "luna": {"fam": lf, "any": la},
            "ens": {"fam": (lf + cf) / 2, "any": (la + clef_sig) / 2}}


# ---------------------------------------------------------------- thresholds and operating points


def dev_threshold(score, real_in, flag_mask=None, p0=0.6, min_flags=5):
    """vision_v1/evaluate.py: the lowest threshold at which at least p0 of the flags (score >= t, within flag_mask)
    are in-family real, with at least min_flags flags. None when no threshold qualifies."""
    s = np.asarray(score, float)
    m = np.ones(len(s), bool) if flag_mask is None else np.asarray(flag_mask, bool)
    s, y = s[m], np.asarray(real_in, float)[m]
    ok = ~np.isnan(s)
    s, y = s[ok], y[ok]
    if not len(s):
        return None
    o = np.argsort(-s, kind="mergesort")
    s, y = s[o], y[o]
    tp = np.cumsum(y)
    n = np.arange(1, len(s) + 1)
    last = np.r_[np.where(np.diff(s) != 0)[0], len(s) - 1]
    good = [i for i in last if n[i] >= min_flags and tp[i] / n[i] >= p0 - 1e-12]
    return float(s[good[-1]]) if good else None


def recall_threshold(y, s, r0=0.5):
    """The highest threshold whose recall reaches r0 (the Clef evaluation's second-stage operating point)."""
    ok = ~np.isnan(s)
    P, R, T = metrics.curve(np.asarray(y, float)[ok], np.asarray(s, float)[ok])
    k = np.where(R >= r0 - 1e-9)[0]
    return float(T[k[0]]) if len(k) else float(T[-1])


def operating_point(flag, real_in, real_any, w=None):
    flag = np.asarray(flag, bool)
    n = int(flag.sum())
    k = int((flag & real_in).sum())
    out = {"flags": n, "realInFamily": k, "realAnyFamily": int((flag & real_any).sum()),
           "precisionInFamily": round(k / n, 3) if n else None, "ci95": wilson(k, n),
           "precisionAnyFamily": round(int((flag & real_any).sum()) / n, 3) if n else None,
           "recallInFamily": round(k / max(1, int(real_in.sum())), 3), "inFamilyRealInSet": int(real_in.sum())}
    if w is not None and n:
        out["weightedPrecisionInFamily"] = round(float((w * (flag & real_in)).sum() / (w * flag).sum()), 3)
    return out


def ranking(y, s):
    y = np.asarray(y, float)
    s = np.asarray(s, float)
    ok = ~np.isnan(s)
    if y[ok].sum() == 0:
        return None
    return metrics.summary(y[ok], s[ok])


def host_boot_diff(groups, y, s1, s2, n=2000, seed=7):
    keys = sorted(set(groups))
    idx = {g: [] for g in keys}
    for i, g in enumerate(groups):
        idx[g].append(i)
    rng = np.random.default_rng(seed)
    y, s1, s2 = np.asarray(y, float), np.asarray(s1, float), np.asarray(s2, float)
    vals = []
    for _ in range(n):
        pick = rng.integers(0, len(keys), len(keys))
        ii = np.concatenate([idx[keys[p]] for p in pick])
        if y[ii].sum() == 0:
            continue
        vals.append(metrics.ap(y[ii], s1[ii]) - metrics.ap(y[ii], s2[ii]))
    return [round(float(np.percentile(vals, 2.5)), 3), round(float(np.percentile(vals, 97.5)), 3)]


def labels_arrays(verdicts, fams):
    real = np.array([v == "real" for v in verdicts])
    return real, {f: real & np.array([x == f for x in fams]) for f in DETECT_FAMS}


def detectors(S, rules_lists, judges):
    """{name: (score, family or None, rule mask or None)} for every judge: any problem, each family on its own and
    each family's rules filtered by the judge; plus the rules themselves."""
    det = {}
    for j in judges:
        det[j + ":any"] = (S[j]["any"], None, None)
    for f in DETECT_FAMS:
        k = FAMILIES.index(f)
        rm = np.array([bool(set(r) & FAMILY_RULES[f]) for r in rules_lists]) if f in FAMILY_RULES else None
        if rm is not None:
            det["rules:" + f] = (rm.astype(float), f, None)
        for j in judges:
            det[j + ":" + f] = (S[j]["fam"][:, k], f, None)
            if rm is not None:
                det["rules+" + j + ":" + f] = (S[j]["fam"][:, k], f, rm)
    return det


# ---------------------------------------------------------------- data


def fresh_dev():
    man = [json.loads(l) for l in open(os.path.join(OUT, "dev", "manifest.jsonl"))]
    lab = json.load(open(os.path.join(OUT, "dev", "labels.json")))["labels"]
    return man, [lab[m["dev"]] for m in man]


def frozen_test():
    td = os.path.join(V1, "test")
    man = [json.loads(l) for l in open(os.path.join(td, "manifest.jsonl"))]
    L = json.load(open(os.path.join(td, "labels.json")))
    man = [m for m in man if m["test"] in L["labels"]]
    return man, [L["labels"][m["test"]] for m in man], L["stats"]


# ---------------------------------------------------------------- commands


def cmd_select(a):
    man, lab = fresh_dev()
    keep = [i for i, x in enumerate(lab) if x["verdict"] != "unclear"]
    y = np.array([lab[i]["verdict"] == "real" for i in keep], float)
    rows = []
    for d in sorted(glob.glob(os.path.join(OUT, "models", "*"))):
        name = os.path.basename(d)
        tj = os.path.join(d, "train.json")
        if name.startswith("smoke") or not os.path.exists(os.path.join(d, "model.pt")) or not os.path.exists(tj):
            continue
        t = json.load(open(tj))
        eps = sorted(glob.glob(os.path.join(d, "scores-freshdev-ep*.npz")), key=lambda p: int(p.split("ep")[-1][:-4]))
        if len(eps) < 3:
            continue
        per = {}
        for p in eps:
            z = np.load(p)
            for s in ("notFine", "anyF", "anyH"):
                if s in z:
                    per.setdefault(s, []).append(metrics.ap(y, z[s][keep]))
        c = t["config"]
        for s, v in per.items():
            rows.append({"run": name, "score": s, "famTarget": c["fam_target"], "anyHead": c["any_head"], "arch": c["arch"],
                         "lr": c["lr"], "lrBackbone": c["lr_backbone"], "epochs": len(eps), "seed": c["seed"],
                         "devApLast3": round(float(np.mean(v[-3:])), 4), "devApFinal": round(v[-1], 4),
                         "round2DevApFinal": t["epochs"][-1]["round2Dev"].get(s), "trainSeconds": t.get("trainSeconds"),
                         "corrNotFine": t["epochs"][-1]["distillVal"]["corrNotFine"]})
    rows.sort(key=lambda r: -r["devApLast3"])
    os.makedirs(ED, exist_ok=True)
    allowed = [r for r in rows if r["score"] in ("notFine", "anyH")]  # the planned any-problem scores
    out = {"devCrops": len(keep), "devReal": int(y.sum()), "rows": rows, "chosen": allowed[0] if allowed else None}
    json.dump(out, open(os.path.join(ED, "selection.json"), "w"), indent=1)
    for r in rows:
        print(json.dumps(r))
    print("chosen:", json.dumps(out["chosen"]))


def all_scores(model, score, crop_ids, rows):
    """Every judge's scores. A crop a teacher gave no usable answer for (an OpenAI refusal, say) scores lowest: it
    is never flagged and ranks last. The counts are kept in S["missing"]."""
    S = teacher_scores(crop_ids)
    S["v2"] = v2_scores(model, rows, score)
    S["v1"] = v1_scores(rows)
    S["missing"] = {}
    for j in JUDGES:
        miss = np.isnan(S[j]["any"])
        S["missing"][j] = int(miss.sum())
        S[j]["any"] = np.where(miss, -1e9, S[j]["any"])
        S[j]["fam"] = np.nan_to_num(S[j]["fam"], nan=0.0)
    return S


def cmd_dev(a):
    man, lab = fresh_dev()
    ids = [m["crop"] for m in man]
    S = all_scores(a.model, a.score, ids, nat_rows(ids))
    real, real_in = labels_arrays([x["verdict"] for x in lab], [x["family"] for x in lab])
    clear = np.array([x["verdict"] != "unclear" for x in lab])
    det = detectors(S, [m["rules"] for m in man], JUDGES)
    res = {"model": os.path.basename(os.path.normpath(a.model)), "score": a.score, "n": len(man), "real": int(real.sum()),
           "unclear": int((~clear).sum()), "realByFamily": {f: int(real_in[f].sum()) for f in DETECT_FAMS},
           "thresholds": {}, "operatingPoints": {}, "ranking": {}, "teacherAnswersMissing": S["missing"]}
    for name, (s, f, rm) in det.items():
        ri = real if f is None else real_in[f]
        t = 0.5 if name.startswith("rules:") else dev_threshold(s, ri, rm)
        # Vision v1 trained on the dev hosts (with Clef's labels): its dev thresholds would be biased, so it keeps
        # the thresholds it chose on round-2 dev labels (its own frozen choice)
        if name.startswith("v1:") or name.startswith("rules+v1:"):
            continue
        res["thresholds"][name] = t
        if t is not None:
            flag = (np.nan_to_num(s, nan=-1e9) >= t) & (rm if rm is not None else True)
            res["operatingPoints"][name] = operating_point(flag, ri, real)
    for j in JUDGES:
        res["ranking"][j] = ranking(real[clear], S[j]["any"][clear])
        if j != "v1":
            res["thresholds"]["secondStage:" + j] = recall_threshold(real[clear], S[j]["any"][clear])
    for f in DETECT_FAMS:
        sel = clear & (~real | real_in[f])
        if real_in[f].sum() >= 5:
            res["ranking"]["family:" + f] = {j: ranking(real_in[f][sel], S[j]["fam"][sel, FAMILIES.index(f)]) for j in JUDGES}
    os.makedirs(ED, exist_ok=True)
    json.dump(res, open(os.path.join(ED, "dev.json"), "w"), indent=1)
    print(json.dumps({"thresholds": {k: v for k, v in res["thresholds"].items() if v is not None}, "ranking": res["ranking"]}, indent=1))


def v1_thresholds():
    """Vision v1's own dev thresholds (round-2 dev labels), renamed to this script's detector names."""
    t = json.load(open(os.path.join(V1_MODEL, "eval-dev-full-any.json")))["thresholds"]
    out = {}
    for k, v in t.items():
        if v is None:
            continue
        if k.startswith("student:"):
            out["v1:" + k.split(":", 1)[1]] = v
        elif k.startswith("rules+student:"):
            out["rules+v1:" + k.split(":", 1)[1]] = v
        elif k == "secondStage:student":
            out["secondStage:v1"] = v
    return out


def cmd_final(a):
    dev = json.load(open(os.path.join(ED, "dev.json")))
    if dev["model"] != os.path.basename(os.path.normpath(a.model)) or dev["score"] != a.score:
        sys.exit("dev.json was made for %s/%s" % (dev["model"], dev["score"]))
    th = dict(dev["thresholds"])
    th.update(v1_thresholds())
    if a.dry:
        out_path = os.path.join(ED, "dry-final.json")
        man, lab = fresh_dev()
        rng = np.random.default_rng(5)
        lab = [lab[i] for i in rng.permutation(len(lab))]
        stats = {"dry": True}
        for m in man:
            m["test"] = m["dev"]
    else:
        out_path = os.path.join(ED, "test-final.json")
        if os.path.exists(out_path):
            sys.exit("the frozen test set was already evaluated for Vision v2 (%s); it is evaluated once" % out_path)
        man, lab, stats = frozen_test()
    ids = [m["crop"] for m in man]
    rows = nat_rows(ids)
    S = all_scores(a.model, a.score, ids, rows)
    verd = [x["verdict"] for x in lab]
    fams = [x["family"] for x in lab]
    real, real_in = labels_arrays(verd, fams)
    clear = np.array([v != "unclear" for v in verd])
    w = np.array([1.0 / m["pi"] for m in man])
    strata = np.array([m["stratum"] for m in man])
    groups = [m["g"] for m in man]

    def gbt(m):  # the v1 gbt-small score the crawl stored in the crop's sidecar
        try:
            s = json.load(open(m["img"][:-4] + ".json")).get("score")
        except (OSError, ValueError, KeyError):
            s = None
        return np.nan if s is None else s
    S["gbtSmallV1"] = {"any": np.array([gbt(m) for m in man], float)}
    det = detectors(S, [m["rules"] for m in man], JUDGES)
    out = {"model": dev["model"], "score": a.score, "n": len(man), "labels": stats, "dry": bool(a.dry),
           "strata": {s: int((strata == s).sum()) for s in sorted(set(strata))},
           "realByStratum": {s: int((real & (strata == s)).sum()) for s in sorted(set(strata))},
           "realByFamily": {f: int(real_in[f].sum()) for f in DETECT_FAMS},
           "thresholds": th, "operatingPoints": {}, "ship": {}, "ranking": {}, "perFamily": {}, "vs": {}, "secondStage": {},
           "teacherAnswersMissing": S["missing"]}
    for name, (s, f, rm) in det.items():
        t = th.get(name)
        if t is None:
            continue
        ri = real if f is None else real_in[f]
        flag = (np.nan_to_num(s, nan=-1e9) >= t) & (rm if rm is not None else True)
        op = operating_point(flag, ri, real, w)
        op["threshold"] = t
        op["byStratum"] = {x: operating_point(flag & (strata == x), ri & (strata == x), real & (strata == x)) for x in sorted(set(strata))}
        out["operatingPoints"][name] = op
        if f is not None and not name.startswith("rules:"):
            two = op["flags"] >= 10 and (op["precisionInFamily"] or 0) >= 0.6
            out["ship"][name] = {"ships": bool(two and (op.get("weightedPrecisionInFamily") or 0) >= 0.6),
                                 "passesFlagsAndPrecision": bool(two), "flags": op["flags"],
                                 "precisionInFamily": op["precisionInFamily"], "ci95": op["ci95"],
                                 "weightedPrecisionInFamily": op.get("weightedPrecisionInFamily")}
    for name in JUDGES + ["gbtSmallV1"]:
        s = S[name]["any"]
        r = {"all": ranking(real[clear], s[clear])}
        for x in sorted(set(strata)):
            k = clear & (strata == x)
            r[x] = ranking(real[k], s[k])
        out["ranking"][name] = r
    rules_any = np.array([bool(m["rules"]) for m in man])
    out["ranking"]["rulesAny"] = {"all": operating_point(rules_any, real, real)}
    for f in DETECT_FAMS:
        nf = int(real_in[f].sum())
        sel = (~real | real_in[f]) & clear  # the family's reals against every not
        y = real_in[f][sel].astype(float)
        k = FAMILIES.index(f)
        if nf < 5:
            continue
        pf = {"real": nf}
        for j in JUDGES:
            pf[j] = metrics.summary(y, S[j]["fam"][sel, k]) if y.sum() else None
        if nf >= 15:
            g = [groups[i] for i in np.nonzero(sel)[0]]
            for j in ("v1", "clef", "luna", "ens"):
                ci = host_boot_diff(g, y, S["v2"]["fam"][sel, k], S[j]["fam"][sel, k])
                d = metrics.ap(y, S["v2"]["fam"][sel, k]) - metrics.ap(y, S[j]["fam"][sel, k])
                out["vs"].setdefault(f, {})[j] = {"diff": round(d, 3), "ci95": ci,
                                                  "verdict": "beats" if ci[0] > 0 else ("falls short" if ci[1] < 0 else "matches")}
        out["perFamily"][f] = pf
    # any problem, paired against each other judge
    g = [groups[i] for i in np.nonzero(clear)[0]]
    for j in ("v1", "clef", "luna", "ens"):
        ci = host_boot_diff(g, real[clear], S["v2"]["any"][clear], S[j]["any"][clear])
        d = metrics.ap(real[clear], S["v2"]["any"][clear]) - metrics.ap(real[clear], S[j]["any"][clear])
        out["vs"].setdefault("any", {})[j] = {"diff": round(d, 3), "ci95": ci,
                                              "verdict": "beats" if ci[0] > 0 else ("falls short" if ci[1] < 0 else "matches")}
    # second stage behind the rules: a rule flags the crop, the judge keeps it at its dev threshold for recall 0.5
    out["secondStage"]["rulesAlone"] = operating_point(rules_any, real, real)
    for j in JUDGES:
        t = th.get("secondStage:" + j)
        if t is None:
            continue
        kept = rules_any & (np.nan_to_num(S[j]["any"], nan=-1e9) >= t)
        op = operating_point(kept, real, real)
        k = rules_any & clear
        op["apWithinRuleFlags"] = round(metrics.ap(real[k].astype(float), np.nan_to_num(S[j]["any"][k], nan=-1e9)), 3)
        op["threshold"] = t
        out["secondStage"][j] = op
    json.dump(out, open(out_path, "w"), indent=1)
    print(json.dumps({"ship": {k: v for k, v in out["ship"].items() if k.startswith(("v2:", "rules+v2:"))},
                      "rankingAll": {k: v["all"] for k, v in out["ranking"].items()}, "vs": out["vs"]}, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["select", "dev", "final"])
    ap.add_argument("--model")
    ap.add_argument("--score", default="notFine", choices=["notFine", "anyF", "anyH"])
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--threads", type=int, default=16)
    a = ap.parse_args()
    import torch
    torch.set_num_threads(a.threads)
    {"select": cmd_select, "dev": cmd_dev, "final": cmd_final}[a.cmd](a)


if __name__ == "__main__":
    main()
