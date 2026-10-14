"""Contact sheets of extra labelling crops from TRAIN hosts, stratified by the v1 rule that flagged them (on the node).

    ~/vt-venv/bin/python vision/label/sheets_extra.py --crops ~/vision-out/v2/crawl \
        --views ~/vision-out/v2/trainset/views.jsonl.gz --out ~/vision-out/v2/sheets-train \
        --quota page-overflow-x=120,text-invisible=60,image-distorted=48,image-broken=24,text-template-leak=24,... \
        --sources gbt=36,random=36

Only crops of natural views of the train split whose host is not a near-duplicate are used, so these labels can
train a model and never reach a val or test page. A crop counts for the first rule in --quota order that flagged it;
--sources takes crops no rule flagged, by their first source. At most --per-view crops per page and device. The sheets
look like sheets.py's (12 per PNG, cell number and crop id, a frame outside the element) and say nothing about the
stratum; selection.json has the counts.
"""

import argparse
import csv
import gzip
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheets import COLS, ROWS, draw_sheet, find_sidecars, layout, parse_quota  # noqa: E402


def main():
    from PIL import ImageFont

    ap = argparse.ArgumentParser()
    ap.add_argument("--crops", required=True)
    ap.add_argument("--views", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--quota", required=True)
    ap.add_argument("--sources", default="")
    ap.add_argument("--per-view", type=int, default=2)
    ap.add_argument("--seed", type=int, default=5)
    ap.add_argument("--width", type=int, default=1400)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    train = set()
    with gzip.open(a.views, "rt") as fh:
        for line in fh:
            v = json.loads(line)
            if not v["round"] and not v["dup"] and v["split"] == "train":
                train.add(v["vid"])
    sides = [s for s in find_sidecars(a.crops) if s.get("vid") in train]
    sides.sort(key=lambda s: s["id"])
    random.Random(a.seed).shuffle(sides)
    rq = parse_quota(a.quota)
    sq = parse_quota(a.sources)
    left = dict(rq + sq)
    per = {}
    kept = []
    for s in sides:
        rules = s.get("rules") or []
        st = next((r for r, _ in rq if r in rules), None)
        if st is None and not rules:
            st = next((k for k, _ in sq if k in (s.get("sources") or [])), None)
        if st is None or left.get(st, 0) <= 0:
            continue
        vk = str(s["vid"]).split("-")[0]
        if per.get(vk, 0) >= a.per_view:
            continue
        per[vk] = per.get(vk, 0) + 1
        left[st] -= 1
        s["_stratum"] = st
        kept.append(s)
    random.Random(a.seed + 1).shuffle(kept)
    try:
        font = ImageFont.load_default(size=15)
    except TypeError:
        font = ImageFont.load_default()
    n = COLS * ROWS
    pos = layout(len(kept), n)
    sheets, rows = [], []
    for k in range(0, len(kept), n):
        cells = [(pos[k + j][1], kept[k + j]) for j in range(min(n, len(kept) - k))]
        file = f"sheet-{k // n:03d}.png"
        size = draw_sheet(cells, a.width, os.path.join(a.out, file), font)
        sheets.append({"file": file, "size": list(size), "cells": [{"cell": c, "id": s["id"]} for c, s in cells]})
        rows += [[s["id"], file, c, "", ""] for c, s in cells]
    json.dump({"built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": a.seed, "perSheet": n,
               "crops": len(kept), "sheets": sheets}, open(os.path.join(a.out, "index.json"), "w"), indent=1)
    strata = {}
    for s in kept:
        strata[s["_stratum"]] = strata.get(s["_stratum"], 0) + 1
    json.dump({"crops": len(kept), "split": "train", "quota": dict(rq), "sources": dict(sq), "perView": a.per_view,
               "strata": strata}, open(os.path.join(a.out, "selection.json"), "w"), indent=1)
    with open(os.path.join(a.out, "labels.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "sheet", "cell", "label", "note"])
        w.writerows(rows)
    print(f"{len(kept)} crops on {len(sheets)} sheets in {a.out}: {strata}")


if __name__ == "__main__":
    main()
