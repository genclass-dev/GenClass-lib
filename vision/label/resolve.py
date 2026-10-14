"""Resolve the labellers' verdicts on the contact-sheet crops and join them to training-set rows (on the node).

    ~/vt-venv/bin/python vision/label/resolve.py --raw ~/vision-out/v2/labels-raw.json \
        --crops ~/vision-out/v2/crawl --set ~/vision-out/v2/trainset --sheets ~/vision-out/v2/sheets \
        --out ~/vision-out/v2/labels.json --public vision/results/v2/labels.json

--raw is the labellers' list as handed over: [{id, verdict (real, unclear, not), family, note?}], one entry per
labeller and crop, so a crop on an overlapping sheet appears twice. Resolution: one verdict is kept as given; two
that agree keep it; two that disagree become "unclear". The family is the first labeller's, unless it is "none" and
the other gave one. The agreement rate is over crops labelled twice.

Writes --out (node only: crop id, view id, matrix row, split, host, the labellers' notes) and --public (for git: crop
ids, which carry no host, with the split, resolved verdict and family, the votes without notes, device, scheme, group
and the stratum that chose the crop). Crop ids are "c" + 12 hex of SHA-1 of the view id and row index.
"""

import argparse
import gzip
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheets import find_sidecars  # noqa: E402

VERDICTS = ("real", "unclear", "not")
STRATA = ("rules", "gbt", "random")  # sheets.py --quota order: a crop counts for the first of its sources


def resolve(votes):
    """[{verdict, family}] (one or two) -> (verdict, family, agree or None)"""
    if len(votes) == 1:
        return votes[0]["verdict"], votes[0]["family"], None
    a, b = votes[0], votes[1]
    agree = a["verdict"] == b["verdict"]
    verdict = a["verdict"] if agree else "unclear"
    fam = a["family"] if a["family"] != "none" else b["family"]
    if verdict == "not":
        fam = "none"
    return verdict, fam, agree


def stratum(sources):
    for s in STRATA:
        if s in (sources or []):
            return s
    return "random"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--crops", required=True)
    ap.add_argument("--set", required=True)
    ap.add_argument("--sheets", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--public", default="")
    a = ap.parse_args()
    raw = json.load(open(a.raw))
    by = defaultdict(list)
    for e in raw:
        assert e["verdict"] in VERDICTS, e
        by[e["id"]].append(e)
    assert all(len(v) <= 2 for v in by.values())
    idx = json.load(open(os.path.join(a.sheets, "index.json")))
    where = {c["id"]: (s["file"], c["cell"]) for s in idx["sheets"] for c in s["cells"]}
    missing = sorted(set(by) - set(where))
    unlabelled = sorted(set(where) - set(by))
    if missing or unlabelled:
        raise SystemExit(f"label ids not on the sheets: {missing[:10]}; sheet ids with no label: {unlabelled[:10]}")
    side = {s["id"]: s for s in find_sidecars(a.crops) if s["id"] in where}
    assert len(side) == len(where), (len(side), len(where))
    views = {}
    with gzip.open(os.path.join(a.set, "views.jsonl.gz"), "rt") as fh:
        for line in fh:
            v = json.loads(line)
            if v["round"] == 0:
                views[v["vid"]] = (v["v"], v["split"], v["host"], v["dup"])
    # matrix row of each (v, i) among the natural rows of the val and test splits
    need = defaultdict(dict)
    for cid, s in side.items():
        v, split, host, dup = views[s["vid"]]
        need[split][(v, s["i"])] = cid
    row = {}
    for split, keys in need.items():
        with gzip.open(os.path.join(a.set, f"meta-{split}.jsonl.gz"), "rt") as fh:
            for r, line in enumerate(fh):
                if '"nat"' not in line:
                    continue
                m = json.loads(line)
                k = (m["v"], m["i"])
                if k in keys:
                    row[keys[k]] = (split, r, m.get("n", 0))
    out, pub = [], []
    for cid in sorted(by):
        votes = by[cid]
        verdict, fam, agree = resolve(votes)
        s = side[cid]
        v, split, host, dup = views[s["vid"]]
        sp, r, nb = row.get(cid, (split, None, None))
        e = {"id": cid, "verdict": verdict, "family": fam, "agree": agree, "votes": votes, "split": split,
             "sheet": where[cid][0], "cell": where[cid][1], "vid": s["vid"], "v": v, "i": s["i"], "row": r, "nb": nb,
             "host": host, "dup": dup, "device": s["device"], "scheme": s["scheme"], "group": s["group"],
             "sources": s["sources"], "stratum": stratum(s["sources"]), "rules": s.get("rules", []),
             "guess": s.get("family"), "tag": s.get("tag"), "role": s.get("role"), "box": s.get("box")}
        out.append(e)
        pub.append({"id": cid, "split": split, "verdict": verdict, "family": fam,
                    "votes": [[x["verdict"], x["family"]] for x in votes], "agree": agree,
                    "device": s["device"], "scheme": s["scheme"], "group": s["group"], "stratum": stratum(s["sources"]),
                    "sources": s["sources"], "rules": s.get("rules", []), "tag": s.get("tag")})
    dbl = [e for e in out if e["agree"] is not None]
    agree_n = sum(e["agree"] for e in dbl)
    pairs = Counter((e["votes"][0]["verdict"], e["votes"][1]["verdict"]) for e in dbl)
    # Cohen's kappa over the doubly labelled crops (two raters, three verdicts)
    pa = Counter(e["votes"][0]["verdict"] for e in dbl)
    pb = Counter(e["votes"][1]["verdict"] for e in dbl)
    n = len(dbl)
    pe = sum(pa[k] * pb[k] for k in VERDICTS) / (n * n) if n else 0
    po = agree_n / n if n else 0
    summary = {
        "labelEntries": len(raw), "crops": len(out), "doubleLabelled": n, "agreements": agree_n,
        "agreementRate": round(po, 4), "cohenKappa": round((po - pe) / (1 - pe), 4) if n and pe < 1 else None,
        "votePairs": {f"{x}/{y}": c for (x, y), c in sorted(pairs.items())},
        "realNotDisagreements": sum(1 for e in dbl if {e["votes"][0]["verdict"], e["votes"][1]["verdict"]} == {"real", "not"}),
        "resolved": dict(Counter(e["verdict"] for e in out)),
        "bySplit": {sp: dict(Counter(e["verdict"] for e in out if e["split"] == sp)) for sp in ("val", "test")},
        "realByFamily": {sp: dict(Counter(e["family"] for e in out if e["split"] == sp and e["verdict"] == "real"))
                         for sp in ("val", "test")},
        "unclearByFamily": dict(Counter(e["family"] for e in out if e["verdict"] == "unclear")),
        "byStratum": {st: dict(Counter(e["verdict"] for e in out if e["stratum"] == st)) for st in STRATA},
        "hosts": {sp: len({e["host"] for e in out if e["split"] == sp}) for sp in ("val", "test")},
        "rowsFound": sum(e["row"] is not None for e in out),
    }
    json.dump({"summary": summary, "labels": out}, open(a.out, "w"), indent=0)
    if a.public:
        json.dump({"summary": summary, "labels": pub}, open(a.public, "w"), indent=0)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
