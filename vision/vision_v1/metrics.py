# Metrics of vision/clef/eval.py (branch wave2/clef-eval, commit 3be5c2f), copied verbatim from its "metrics"
# section so every number is computed exactly as the Clef report computed it.

import numpy as np

def curve(y, s):
    """Precision and recall at every distinct threshold, scores descending (ties as one step)."""
    y = np.asarray(y, float)
    s = np.asarray(s, float)
    o = np.argsort(-s, kind="mergesort")
    y, s = y[o], s[o]
    tp = np.cumsum(y)
    fp = np.cumsum(1 - y)
    last = np.r_[np.where(np.diff(s) != 0)[0], len(s) - 1]
    P = tp[last] / (tp[last] + fp[last])
    R = tp[last] / max(1, y.sum())
    return P, R, s[last]


def ap(y, s):
    P, R, _ = curve(y, s)
    r_prev = np.r_[0, R[:-1]]
    return float(np.sum((R - r_prev) * P))


def auc(y, s):
    y = np.asarray(y)
    s = np.asarray(s, float)
    pos, neg = s[y == 1], s[y == 0]
    if not len(pos) or not len(neg):
        return None
    # Mann-Whitney U with average ranks for ties
    allv = np.r_[pos, neg]
    order = np.argsort(allv, kind="mergesort")
    sv = allv[order]
    r = np.empty(len(allv))
    i = 0
    while i < len(sv):
        j = i
        while j + 1 < len(sv) and sv[j + 1] == sv[i]:
            j += 1
        r[order[i: j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return float((r[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def p_at_r(y, s, r0):
    P, R, _ = curve(y, s)
    ok = R >= r0 - 1e-9
    return float(P[ok].max()) if ok.any() else None


def r_at_p(y, s, p0):
    P, R, _ = curve(y, s)
    ok = P >= p0 - 1e-9
    return float(R[ok].max()) if ok.any() else 0.0


def at_threshold(y, s, t):
    y = np.asarray(y)
    s = np.asarray(s, float)
    pred = s >= t
    tp = int((pred & (y == 1)).sum())
    fp = int((pred & (y == 0)).sum())
    return {"threshold": round(float(t), 4), "flagged": int(pred.sum()), "tp": tp, "fp": fp,
            "precision": round(tp / max(1, tp + fp), 3), "recall": round(tp / max(1, int((y == 1).sum())), 3)}


def summary(y, s):
    y = np.asarray(y)
    if (y == 1).sum() == 0:
        return None
    r = lambda v: None if v is None else round(v, 3)
    return {"n": int(len(y)), "real": int((y == 1).sum()), "ap": r(ap(y, s)), "rocAuc": r(auc(y, s)),
            "precisionAtRecall0.5": r(p_at_r(y, s, 0.5)), "recallAtPrecision0.6": r(r_at_p(y, s, 0.6)),
            "recallAtPrecision0.8": r(r_at_p(y, s, 0.8))}


def bootstrap(items, score, stat, n=1000, seed=7):
    """Host-level bootstrap 95% interval of stat(y, s)."""
    groups = {}
    for k, it in enumerate(items):
        groups.setdefault(it["g"], []).append(k)
    keys = list(groups)
    rng = np.random.default_rng(seed)
    y = np.array([it["y"] for it in items])
    s = np.array(score)
    vals = []
    for _ in range(n):
        pick = rng.integers(0, len(keys), len(keys))
        idx = np.concatenate([groups[keys[p]] for p in pick])
        if y[idx].sum() == 0:
            continue
        v = stat(y[idx], s[idx])
        if v is not None:
            vals.append(v)
    if not vals:
        return None
    return [round(float(np.percentile(vals, 2.5)), 3), round(float(np.percentile(vals, 97.5)), 3)]

