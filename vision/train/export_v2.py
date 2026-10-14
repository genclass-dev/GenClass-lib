"""Export the shipping v2 detectors as one JSON bundle for the JS evaluator (detect_v2.mjs) and check parity (node).

    LD_LIBRARY_PATH=~/vt-venv/gomp ~/vt-venv/bin/python vision/train/export_v2.py --models ~/vision-out/v2/models/v2b \
        --out ~/vision-out/v2/export

Reads eval-v2.json (which families ship, and how) and train.json (stack coefficients), and writes:
  visual-v2.json        {"format": "genclass-visual-2", inputs, ruleInputs, models: {name: genclass-gbt-1 tree model},
                         detectors: [...]}. Every detector has a score: one model's probability, or for a stack
                         sigmoid(intercept + sum of coef[j] * logit(score of models[j])), logits clipped at 1e-6. Kind
                         "model": an element is reported when its score is at least threshold. Kind "check-filter": a
                         finding of one of `checks` (the family's measured checks) is reported only when the element's
                         score is at least threshold.
                         A model whose inputs include rule_* names reads the v1 rule bits (candidates.mjs v1Rules).
  sample-v2-X.f32, sample-v2-R.f32, sample-v2-p.f64   test rows (model inputs, rule bits) and each detector's Python
                         score, for `node vision/train/detect_v2.mjs`
  export-v2.json        sizes, parity and the LightGBM cost
"""

import argparse
import gzip
import json
import os
import sys
import time

import lightgbm as lgb
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import RULES, Cols, Split, load_schema, load_views, log, model_inputs, rules  # noqa: E402
from eval_v2 import RULE_FAMILY  # noqa: E402
from export import compact, score_compact  # noqa: E402


def lg(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/v2/trainset"))
    ap.add_argument("--models", default=os.path.expanduser("~/vision-out/v2/models/v2b"))
    ap.add_argument("--out", default=os.path.expanduser("~/vision-out/v2/export"))
    ap.add_argument("--ship", default="media:hybrid,responsive:responsive+lab",
                    help="family:how, how = hybrid (eval-v2.json hybrid choice) or a model tag at its ship threshold")
    ap.add_argument("--sample", type=int, default=20000)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    ev = json.load(open(os.path.join(a.models, "eval-v2.json")))
    tr = json.load(open(os.path.join(a.models, "train.json")))
    schema = load_schema(a.set)
    cols = Cols(schema)
    views = load_views(a.set)
    te = Split(a.set, "test", schema)
    Xall, names = model_inputs(te.X, cols)
    rb = rules(te, cols, views)
    R = np.stack([((rb >> k) & 1).astype(np.float32) for k in range(len(RULES))], axis=1)
    rnames = [f"rule_{r.replace('-', '_')}" for r in RULES]
    models, detectors = {}, []

    def need(tag):
        if tag not in models:
            models[tag] = lgb.Booster(model_file=os.path.join(a.models, f"model-{tag}.txt"))
        return models[tag]

    for item in a.ship.split(","):
        fam, how = item.split(":")
        def score_spec(tag):
            if "+" in tag:
                base, other = tag.split("+")
                need(base)
                need(other)
                t = tr["models"][tag]
                return {"models": [base, other], "coef": t["coef"], "intercept": t["intercept"]}
            need(tag)
            return {"models": [tag], "coef": [1.0], "intercept": 0.0}

        if how == "hybrid":
            c = ev["hybrid"]["families"][fam]["chosen"]
            assert ev["hybrid"]["families"][fam]["ships"], fam
            detectors.append({"family": fam, "kind": "check-filter", "score": c["score"],
                              "checks": [r for r, rf in RULE_FAMILY.items() if rf == fam], **score_spec(c["score"]),
                              "threshold": c["threshold"]})
        else:
            m = ev["models"][how]
            assert m["ships"], how
            detectors.append({"family": fam, "kind": "model", "score": how, **score_spec(how),
                              "threshold": m["ops"]["ship"]["threshold"]})
    rng = np.random.default_rng(3)
    idx = rng.choice(len(te.y), min(a.sample, len(te.y)), replace=False)
    # plus every test row a check filter's checks flag (at most 5,000), so the filter's branch is exercised
    cbits = sum(1 << RULES.index(r) for d in detectors if d["kind"] == "check-filter" for r in d["checks"])
    flagged = np.flatnonzero((rb & cbits) != 0) if cbits else np.zeros(0, np.int64)
    idx = np.unique(np.concatenate([idx, flagged[:5000]]))
    X, Rb = Xall[idx].astype(np.float32), R[idx]
    rep = {"detectors": detectors, "models": {}, "sampleRows": int(len(idx))}
    out_models, raw = {}, {}
    for tag, bst in models.items():
        fn = bst.feature_name()
        withrules = fn[len(names):] == rnames and fn[:len(names)] == names
        assert fn == names or withrules, tag
        Xi = np.concatenate([X, Rb], axis=1) if withrules else X
        p = bst.predict(Xi)
        raw[tag] = p
        m = compact(bst)
        js = json.dumps(m, separators=(",", ":"))
        m["_catsets"] = [set(c) for c in m["cats"]]
        pc = score_compact(m, Xi[:2000].astype(np.float64))
        del m["_catsets"]
        out_models[tag] = m
        t0 = time.time()
        bst.predict(Xi, num_threads=1)
        rep["models"][tag] = {"trees": bst.num_trees(), "inputs": len(fn), "ruleInputs": bool(withrules),
                              "jsonBytes": len(js), "gzipBytes": len(gzip.compress(js.encode(), 9)),
                              "nodes": sum(len(t) // 4 for t in m["trees"]),
                              "maxAbsDiffPython": float(np.abs(pc - p[:2000]).max()),
                              "lightgbmSecondsPerRow1Thread": (time.time() - t0) / len(Xi)}
        log(f"{tag}: {rep['models'][tag]}")
    # each detector's score on the sample (the reference for the JS check) and its agreement with eval-v2 scores
    P = []
    for d in detectors:
        if len(d["models"]) == 1 and d["coef"] == [1.0] and d["intercept"] == 0.0:
            s = raw[d["models"][0]]
        else:
            z = d["intercept"] + sum(c * lg(raw[t]) for c, t in zip(d["coef"], d["models"]))
            s = 1 / (1 + np.exp(-z))
        ref = np.load(os.path.join(a.models, f"scores-{d['score']}-test.npy"))[idx]
        if d["kind"] == "check-filter":
            on = (rb[idx] & sum(1 << RULES.index(r) for r in d["checks"])) != 0
            s, ref = np.where(on, s, 0.0), np.where(on, ref, 0.0)
        d["sampleFlags"] = int((s >= d["threshold"]).sum())
        d["maxAbsDiffEval"] = float(np.abs(s - ref).max())
        P.append(s)
    bundle = {"format": "genclass-visual-2", "version": "v2-2026-10-14", "inputs": names, "ruleInputs": rnames,
              "rules": RULES, "models": out_models,
              "detectors": [{k: v for k, v in d.items() if k not in ("sampleFlags", "maxAbsDiffEval")} for d in detectors]}
    js = json.dumps(bundle, separators=(",", ":"))
    open(os.path.join(a.out, "visual-v2.json"), "w").write(js)
    rep["bundle"] = {"bytes": len(js), "gzipBytes": len(gzip.compress(js.encode(), 9))}
    X.tofile(os.path.join(a.out, "sample-v2-X.f32"))
    Rb.tofile(os.path.join(a.out, "sample-v2-R.f32"))
    np.stack(P, axis=1).astype(np.float64).tofile(os.path.join(a.out, "sample-v2-p.f64"))
    json.dump(rep, open(os.path.join(a.out, "export-v2.json"), "w"), indent=1)
    log(f"bundle {rep['bundle']}; detectors {[(d['family'], d['kind'], d['sampleFlags'], d['maxAbsDiffEval']) for d in detectors]}")


if __name__ == "__main__":
    main()
