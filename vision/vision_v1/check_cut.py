#!/usr/bin/env python3
# Geometry check of cut_from_shot: for a sample of crawl candidate crops (cut by crawl.mjs from a full-resolution
# viewport PNG), cut the same rectangle out of the stored 0.5x / 0.75x viewport shot and compare the two images.
# A correct cut matches closely (high correlation); a rectangle off by a few pixels does not. Prints numbers only.
#
#   check_cut.py [--n 300]

import argparse
import json
import os
import random
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT, cut_from_shot, degrade  # noqa: E402


def corr(a, b):
    a = a.astype(np.float64).ravel()
    b = b.astype(np.float64).ravel()
    a -= a.mean()
    b -= b.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / d) if d > 0 else 1.0


def main():
    from PIL import Image
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=300)
    a = ap.parse_args()
    idx = os.path.join(OUT, "index")
    shots = {}
    nat_shot = {}
    with open(os.path.join(idx, "shots.jsonl")) as fh:
        for line in fh:
            r = json.loads(line)
            shots[r["id"]] = r["shot"]
    items = []
    with open(os.path.join(idx, "nat.jsonl")) as fh:
        for line in fh:
            it = json.loads(line)
            if it["kind"] == "nat":
                nat_shot[it["vid"]] = shots[it["id"]]
            items.append(it)
    cands = [it for it in items if it["kind"] == "cand" and it["vid"] in nat_shot]
    random.Random(3).shuffle(cands)
    rs, rs_shift, rs_deg = [], [], []
    for it in cands[: a.n]:
        full = Image.open(it["img"]).convert("RGB")
        shot = Image.open(nat_shot[it["vid"]]).convert("RGB")
        vw = it["crop"]["viewport"][0]
        cut = cut_from_shot(shot, it["crop"]["rect"], vw)
        if cut.size != full.size:
            continue
        rs.append(corr(np.asarray(full), np.asarray(cut)))
        x0, y0, x1, y1 = it["crop"]["rect"]
        sh = cut_from_shot(shot, [x0 + 6, y0 + 6, x1 + 6, y1 + 6], vw).resize(full.size)
        rs_shift.append(corr(np.asarray(full), np.asarray(sh)))
        rs_deg.append(corr(np.asarray(full), np.asarray(degrade(full, it["device"]))))
    q = lambda v: [round(float(x), 3) for x in np.quantile(v, [0.1, 0.5, 0.9])]
    print(json.dumps({"n": len(rs), "corrCut": q(rs), "corrCutShifted6px": q(rs_shift), "corrDegradedFull": q(rs_deg)}))


if __name__ == "__main__":
    main()
