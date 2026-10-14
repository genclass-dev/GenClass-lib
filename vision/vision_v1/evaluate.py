#!/usr/bin/env python3
# Evaluation of Vision v1 against Clef (the teacher), the v1 measured rules and the v1 gbt-small model.
#
#   evaluate.py dev   --model DIR [--input full|degraded]   dev numbers only (the 2,200 round-2 crops); never reads
#                                                          a test label
#   evaluate.py final --model DIR --input full|degraded     the one test evaluation (TEST-FROZEN.md); refuses to run
#                                                          when OUT/test/results-final.json already exists
#
# Dev = the round-2 labelled crops (AI-agent labels): thresholds and every choice. Test = the fresh set
# (OUT/test/manifest.jsonl, labels.json from freshtest.py resolve). Unclear counts as not real in every precision;
# ranking metrics leave unclear out. Output: JSON with aggregates only (no crop ids, no hosts).

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT, FAMILIES  # noqa: E402
import metrics  # noqa: E402

TD = os.environ.get("VV1_TEST_DIR", os.path.join(OUT, "test"))  # overridden only by the dry run (dryrun.py)
# the v1 rules that look for each family (vision/clef/eval.py FAMILY_RULES)
FAMILY_RULES = {"media": {"image-broken", "image-distorted", "media-failed", "text-placeholder"},
                "overflow": {"page-overflow-x"}, "occlusion": {"control-unreachable", "click-blocked"},
                "dark": {"text-invisible", "css-var-undefined"}, "text": {"text-invisible", "css-var-undefined", "font-failed"},
                "leaks": {"text-template-leak", "text-placeholder"}}
DETECT_FAMS = [f for f in FAMILIES if f != "none"]


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


def clef_scores(ids, extra_dirs=()):
    """Per crop id: Clef family probabilities (mean of the two prompts) and the anyProblem logit sum."""
    from clef_label import answered
    A, Bv = answered("clef-img-p3"), answered("clef-imgonly-p2")
    for d in extra_dirs:  # the Clef evaluation's cached answers (one JSON file per crop)
        for v, store in (("clef-img-p3", A), ("clef-imgonly-p2", Bv)):
            p = os.path.join(d, v)
            if os.path.isdir(p):
                for f in os.listdir(p):
                    cid = f[:-5]
                    if cid not in store:
                        store[cid] = json.load(open(os.path.join(p, f)))
    fam = np.full((len(ids), len(FAMILIES)), np.nan)
    anyl = np.full(len(ids), np.nan)
    for k, cid in enumerate(ids):
        rs = [r[cid] for r in (A, Bv) if cid in r]
        if not rs:
            continue
        ps = [np.array([r["answers"]["family"]["probabilities"].get(c, 0.0) for c in FAMILIES]) for r in rs]
        ps = [p / p.sum() for p in ps]
        fam[k] = np.mean(ps, 0)
        anyl[k] = float(np.mean([lg(1 - p[0]) for p in ps])) * 2
    return fam, anyl


def clef_variant_any(ids):
    """anyProblem of each Clef prompt on its own, per crop id (NaN where it has no answer)."""
    from clef_label import answered
    out = {}
    for v in ("clef-img-p3", "clef-imgonly-p2"):
        A = answered(v)
        out[v] = np.array([1 - A[c]["answers"]["family"]["probabilities"].get("none", 0.0) if c in A else np.nan for c in ids])
    return out


def student_scores(model_dir, pack, rows, which):
    import torch
    from train import Student, load_pack, score
    ck = torch.load(os.path.join(model_dir, "model.pt"), map_location="cpu")
    from common import IN_W as _W, IN_H as _H
    if list(ck.get("input", [_W, _H])) != [_W, _H]:
        sys.exit("the model was trained at %s; set VV1_INPUT to match" % ck["input"])
    m = Student(ck["arch"], pretrained=False, any_head=ck.get("anyHead", False))
    m.load_state_dict(ck["state"])
    m = m.to(memory_format=torch.channels_last)
    _, X, Xd, F = load_pack(pack)
    rows = np.asarray(rows)
    o = np.argsort(rows)
    srt = rows[o]
    out = score(m, (X if which == "full" else Xd)[srt], F[srt])
    inv = np.empty(len(rows), int)
    inv[o] = np.arange(len(rows))
    return {k: v[inv] for k, v in out.items()}


# ---------------------------------------------------------------- thresholds and operating points


def dev_threshold(score, real_in, flag_mask=None, p0=0.6, min_flags=5):
    """The lowest threshold at which at least p0 of the flags (score >= t, within flag_mask) are in-family real,
    with at least min_flags flags. None when no threshold qualifies."""
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


# ---------------------------------------------------------------- data


def dev_set():
    items = [json.loads(l) for l in open(os.path.join(OUT, "index", "lab.jsonl"))]
    rows = [k for k, it in enumerate(items) if it["kind"] == "lab"]
    d = [items[k] for k in rows]
    return d, rows


def detectors(student, clef_fam, clef_any, rules_lists):
    """Scores per detector: {name: (score array, family or None, rule mask or None)}."""
    det = {"student:any": (student["any"], None, None), "clef:any": (clef_any, None, None)}
    for f in DETECT_FAMS:
        k = FAMILIES.index(f)
        det["student:" + f] = (student["fam"][:, k], f, None)
        det["clef:" + f] = (clef_fam[:, k], f, None)
        if f in FAMILY_RULES:
            rm = np.array([bool(set(r) & FAMILY_RULES[f]) for r in rules_lists])
            det["rules:" + f] = (rm.astype(float), f, None)
            det["rules+student:" + f] = (student["fam"][:, k], f, rm)
            det["rules+clef:" + f] = (clef_fam[:, k], f, rm)
    return det


def labels_arrays(verdicts, fams):
    real = np.array([v == "real" for v in verdicts])
    return real, {f: real & np.array([x == f for x in fams]) for f in DETECT_FAMS}


def cmd(a):
    dev, dev_rows = dev_set()
    dev_ids = [it["id"] for it in dev]
    st_dev = student_scores(a.model, "lab", dev_rows, a.input)
    if a.score == "anyT":
        st_dev["any"] = st_dev["anyT"]
    cf_dev, ca_dev = clef_scores(dev_ids, extra_dirs=[os.path.join(OUT, "clef-ref", "runs")])
    d_real, d_in = labels_arrays([it["verdict"] for it in dev], [it["family"] for it in dev])
    det_dev = detectors(st_dev, cf_dev, ca_dev, [it["rules"] for it in dev])
    res = {"input": a.input, "score": a.score, "model": os.path.basename(os.path.normpath(a.model)), "dev": {}, "thresholds": {}}
    clear = np.array([it["verdict"] != "unclear" for it in dev])
    rep = np.array([it["clefSplit"] == "report" for it in dev])
    gbt_dev = np.array([it.get("gbt") if it.get("gbt") is not None else np.nan for it in dev], float)
    for name, s in (("student", st_dev["any"]), ("clef", ca_dev), ("gbtSmallV1", gbt_dev)):
        res["dev"][name] = {"all": ranking(d_real[clear], s[clear]), "clefReportSplit": ranking(d_real[clear & rep], s[clear & rep]),
                            "clefDevSplit": ranking(d_real[clear & ~rep], s[clear & ~rep])}
    for f in ("overflow", "media", "dark", "occlusion"):  # the Clef report's families, own-family probability
        k = FAMILIES.index(f)
        sel = clear & rep & (~d_real | d_in[f])
        res["dev"].setdefault("clefReportSplitByFamily", {})[f] = {
            "real": int(d_in[f][sel].sum()), "student": ranking(d_in[f][sel], st_dev["fam"][sel, k]),
            "clef": ranking(d_in[f][sel], cf_dev[sel, k])}
    for name, (s, f, rm) in det_dev.items():
        real_in = d_real if f is None else d_in[f]
        if name.startswith("rules:"):
            t = 0.5
        else:
            t = dev_threshold(s, real_in, rm)
        res["thresholds"][name] = t
        if t is not None:
            flag = (np.nan_to_num(s, nan=-1) >= t) & (rm if rm is not None else True)
            res["dev"].setdefault("operatingPoints", {})[name] = operating_point(flag, real_in, d_real)
    # the scanner's use, as in the Clef evaluation: rules first, then the score at the dev threshold for recall 0.5
    res["dev"]["secondStage"] = {}
    rule_any = np.array([bool(it["rules"]) for it in dev])
    for name, s in (("student", st_dev["any"]), ("clef", ca_dev)):
        P, R, T = metrics.curve(d_real[clear].astype(float), s[clear])
        okk = np.where(R >= 0.5 - 1e-9)[0]
        t = float(T[okk[0]]) if len(okk) else float(T[-1])
        res["thresholds"]["secondStage:" + name] = t
        kept = rule_any & (s >= t)
        res["dev"]["secondStage"][name] = operating_point(kept, d_real, d_real)
    # the Clef evaluation's open question, image + tag only against image + facts, on labels it never saw: the 420
    # crops of train hosts that round 2's training agent labelled (unclear left out)
    allitems = [json.loads(l) for l in open(os.path.join(OUT, "index", "lab.jsonl"))]
    xs = [it for it in allitems if it["kind"] == "labx" and it["verdict"] != "unclear"]
    yx = np.array([it["verdict"] == "real" for it in xs], float)
    cv = clef_variant_any([it["id"] for it in xs])
    res["dev"]["clefVariantsOnExtraLabels"] = {v: ranking(yx, s) for v, s in cv.items()}
    res["dev"]["clefVariantsOnExtraLabels"]["sumOfLogits"] = ranking(yx, lg(cv["clef-img-p3"]) + lg(cv["clef-imgonly-p2"]))
    if a.cmd == "dev":
        print(json.dumps(res["dev"], indent=1)[:6000])
        json.dump(res, open(os.path.join(a.model, "eval-dev-%s-%s.json" % (a.input, a.score)), "w"), indent=1)
        return

    # ---------------------------------------------------------------- the one test evaluation
    final = os.path.join(TD, "results-final.json")
    if os.path.exists(final):
        sys.exit("the test set was already evaluated (%s); it is evaluated once" % final)
    man = [json.loads(l) for l in open(os.path.join(TD, "manifest.jsonl"))]
    lab = json.load(open(os.path.join(TD, "labels.json")))["labels"]
    man = [m for m in man if m["test"] in lab]
    from common import PACK_DIR
    nat = json.load(open(os.path.join(PACK_DIR, "nat.json")))["items"]
    row_of = {it["id"]: k for k, it in enumerate(nat)}
    rows = [row_of[m["crop"]] for m in man]
    st = student_scores(a.model, "nat", rows, a.input)
    if a.score == "anyT":
        st["any"] = st["anyT"]
    cf, ca = clef_scores([m["crop"] for m in man])
    verd = [lab[m["test"]]["verdict"] for m in man]
    fams = [lab[m["test"]]["family"] for m in man]
    real, real_in = labels_arrays(verd, fams)
    w = np.array([1.0 / m["pi"] for m in man])
    strata = np.array([m["stratum"] for m in man])
    groups = [m["g"] for m in man]
    def v1_score(m):  # the v1 gbt-small score the crawl stored in the crop's sidecar
        try:
            s = json.load(open(m["img"][:-4] + ".json")).get("score")
        except (OSError, ValueError, KeyError):
            s = None
        return np.nan if s is None else s
    gbt = np.array([v1_score(m) for m in man], float)
    det = detectors(st, cf, ca, [m["rules"] for m in man])
    out = {"input": a.input, "score": a.score, "model": res["model"], "n": len(man), "labels": json.load(open(os.path.join(TD, "labels.json")))["stats"],
           "strata": {s: int((strata == s).sum()) for s in sorted(set(strata))},
           "realByStratum": {s: int((real & (strata == s)).sum()) for s in sorted(set(strata))},
           "thresholds": res["thresholds"], "operatingPoints": {}, "ship": {}, "ranking": {}, "vsClef": {}}
    for name, (s, f, rm) in det.items():
        t = res["thresholds"].get(name)
        if t is None:
            continue
        ri = real if f is None else real_in[f]
        flag = (np.nan_to_num(s, nan=-1) >= t) & (rm if rm is not None else True)
        op = operating_point(flag, ri, real, w)
        op["byStratum"] = {x: operating_point(flag & (strata == x), ri & (strata == x), real & (strata == x)) for x in sorted(set(strata))}
        out["operatingPoints"][name] = op
        if f is not None and not name.startswith("rules:"):
            ok = (op["flags"] >= 10 and (op["precisionInFamily"] or 0) >= 0.6 and (op.get("weightedPrecisionInFamily") or 0) >= 0.6)
            out["ship"][name] = {"ships": bool(ok), "flags": op["flags"], "precisionInFamily": op["precisionInFamily"],
                                 "weightedPrecisionInFamily": op.get("weightedPrecisionInFamily"), "ci95": op["ci95"]}
    clear = np.array([v != "unclear" for v in verd])
    for name, s in (("student", st["any"]), ("clef", ca), ("gbtSmallV1", gbt)):
        r = {"all": ranking(real[clear], s[clear])}
        for x in sorted(set(strata)):
            k = clear & (strata == x)
            r[x] = ranking(real[k], s[k])
        out["ranking"][name] = r
    # Clef's two prompts on their own (image + facts against image + tag only), on the strata Clef did not choose
    cv = clef_variant_any([m["crop"] for m in man])
    out["clefVariants"] = {}
    for v, s in cv.items():
        out["clefVariants"][v] = {"all": ranking(real[clear], s[clear])}
        for x in ("rules", "random"):
            k = clear & (strata == x)
            out["clefVariants"][v][x] = ranking(real[k], s[k])
    for f in DETECT_FAMS:
        nf = int(real_in[f].sum())
        if nf < 15:
            continue
        k = FAMILIES.index(f)
        sel = (~real | real_in[f]) & clear  # the family's reals against every not
        y = real_in[f][sel].astype(float)
        s1, s2 = st["fam"][sel, k], cf[sel, k]
        g = [groups[i] for i in np.nonzero(sel)[0]]
        ci = host_boot_diff(g, y, s1, s2)
        out["vsClef"][f] = {"real": nf, "studentAP": round(metrics.ap(y, s1), 3), "clefAP": round(metrics.ap(y, s2), 3),
                            "diff": round(metrics.ap(y, s1) - metrics.ap(y, s2), 3), "ci95": ci,
                            "verdict": "beats" if ci[0] > 0 else ("falls short" if ci[1] < 0 else "matches"),
                            "student": metrics.summary(y, s1), "clef": metrics.summary(y, s2)}
    # second stage behind the rules (the Clef evaluation's scanner use)
    rule_any = np.array([bool(m["rules"]) for m in man])
    out["secondStage"] = {"rulesAlone": operating_point(rule_any, real, real)}
    for name, s in (("student", st["any"]), ("clef", ca)):
        t = res["thresholds"]["secondStage:" + name]
        out["secondStage"][name] = operating_point(rule_any & (np.nan_to_num(s, nan=-1e9) >= t), real, real)
    json.dump(out, open(final, "w"), indent=1)
    print(json.dumps({"ship": out["ship"], "vsClef": {f: {k: v[k] for k in ("real", "studentAP", "clefAP", "diff", "ci95", "verdict")}
                                                      for f, v in out["vsClef"].items()}, "ranking": out["ranking"]}, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["dev", "final"])
    ap.add_argument("--model", required=True)
    ap.add_argument("--input", default="full", choices=["full", "degraded"])
    ap.add_argument("--threads", type=int, default=16)
    ap.add_argument("--score", default="any", choices=["any", "anyT"], help="the student's any-problem score (the dev choice)")
    a = ap.parse_args()
    import torch
    torch.set_num_threads(a.threads)
    cmd(a)


if __name__ == "__main__":
    main()
