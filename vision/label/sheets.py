"""Contact sheets of labelling candidates, on the node (crops never leave it, except into a private scratch folder).

    ~/vt-venv/bin/python vision/label/sheets.py --crops ~/vision-out/crawl --out ~/vision-out/label [--seed 3]
        [--limit 0] [--quota rules=800,gbt=700,random=700] [--per-view 2] [--per-sheet 12] [--width 1400]
        [--views ~/vision-out/trainset/views.jsonl.gz --splits val,test]

Reads every crop sidecar (crops/<id>.json next to crops/<id>.jpg, written by src/crawl.mjs) under --crops, shuffles
them with a seeded RNG (so a sheet mixes pages, devices and the sources that chose the crops), optionally keeps a
stratified subset (--quota: crops per source, a crop counting for the first of its sources in the order given;
--per-view: at most that many crops per page and device, read from the view id; --views and --splits: only crops of
natural views in those training-set splits, near-duplicate hosts left out, so a real-bug test set never holds a page
a model was trained on), and tiles them 3 x 4
per sheet into PNGs about --width px wide. Each cell shows the crop scaled to fit (at most 3x), a thin magenta frame
just outside the element's box, and a caption with the cell number and the crop id. Nothing on a sheet says which
source chose a crop (v1 model, rules, random) or the model's score, so labelling is blind.

Writes, in OUT:
  sheet-NNN.png      the contact sheets
  index.json         {built, seed, perSheet, sheets: [{file, cells: [{cell, id}]}]}: where each id is; no sources
  labels.csv         id, sheet, cell, label, note (empty label column to fill: real, unclear or not)
The sidecars keep the rest (vid and row index, sources, score, rules, family guess); join on id after labelling.
"""

import argparse
import csv
import glob
import gzip
import json
import os
import random
import time

COLS, ROWS = 3, 4
CAPTION = 26
PAD = 6
FRAME = (230, 0, 160)


def find_sidecars(root):
    """Crop sidecars under root: <root>/crops/*.json, <root>/shard-*/crops/*.json, or root itself."""
    pats = [os.path.join(root, "*.json"), os.path.join(root, "crops", "*.json"), os.path.join(root, "shard-*", "crops", "*.json")]
    out = []
    seen = set()
    for p in pats:
        for f in sorted(glob.glob(p)):
            if f in seen:
                continue
            seen.add(f)
            try:
                side = json.load(open(f))
            except (OSError, ValueError):
                continue
            if not isinstance(side, dict) or "id" not in side:
                continue
            img = os.path.join(os.path.dirname(f), side.get("file") or side["id"] + ".jpg")
            if os.path.exists(img):
                side["_img"] = img
                out.append(side)
    return out


def allowed_views(path, splits):
    """{vid: split} of the natural views in `splits` (a set) whose host is not a near-duplicate, from build_set.mjs
    views.jsonl.gz."""
    out = {}
    with gzip.open(path, "rt") as fh:
        for line in fh:
            v = json.loads(line)
            if not v.get("round") and not v.get("dup") and v.get("split") in splits:
                out[v["vid"]] = v["split"]
    return out


def parse_quota(text):
    """"rules=800,gbt=700,random=700" -> [("rules", 800), ("gbt", 700), ("random", 700)] (order kept)."""
    out = []
    for part in (text or "").split(","):
        if part.strip():
            k, v = part.split("=")
            out.append((k.strip(), int(v)))
    return out


def select(sides, quota, per_view=0):
    """Walk the (already shuffled) sidecars and keep a crop when its stratum (the first source in quota order that
    chose it) still has room and its page and device (the view id before the scheme) has fewer than per_view crops
    kept (0: no cap). Returns the kept sidecars in walk order; crops with no stratum in the quota are skipped."""
    left = dict(quota)
    order = [k for k, _ in quota]
    views = {}
    out = []
    for side in sides:
        srcs = side.get("sources") or []
        stratum = next((k for k in order if k in srcs), None)
        if stratum is None or left[stratum] <= 0:
            continue
        vkey = str(side.get("vid", "")).split("-")[0]
        if per_view and views.get(vkey, 0) >= per_view:
            continue
        views[vkey] = views.get(vkey, 0) + 1
        left[stratum] -= 1
        side["_stratum"] = stratum
        out.append(side)
        if all(v <= 0 for v in left.values()):
            break
    return out


def layout(n, per_sheet=COLS * ROWS):
    """Sheet and cell (1-based) of each of n crops in order."""
    return [(k // per_sheet, k % per_sheet + 1) for k in range(n)]


def fit(w, h, cw, ch, up=3.0):
    """Scale factor that fits a w x h crop into cw x ch, at most `up`."""
    return min(cw / max(w, 1), ch / max(h, 1), up)


def draw_sheet(cells, width, path, font):
    from PIL import Image, ImageDraw

    cw = width // COLS
    ch = int(cw * 0.78) + CAPTION
    sheet = Image.new("RGB", (cw * COLS, ch * ROWS), (236, 236, 236))
    d = ImageDraw.Draw(sheet)
    for k, (cell, side) in enumerate(cells):
        cx, cy = (k % COLS) * cw, (k // COLS) * ch
        d.rectangle([cx, cy, cx + cw - 1, cy + ch - 1], outline=(150, 150, 150))
        d.text((cx + PAD, cy + 5), f"{cell:>2}  {side['id']}", fill=(0, 0, 0), font=font)
        im = Image.open(side["_img"]).convert("RGB")
        aw, ah = cw - 2 * PAD, ch - CAPTION - PAD
        f = fit(im.width, im.height, aw, ah)
        im = im.resize((max(1, int(im.width * f)), max(1, int(im.height * f))))
        ox = cx + PAD + (aw - im.width) // 2
        oy = cy + CAPTION + (ah - im.height) // 2
        sheet.paste(im, (ox, oy))
        box = side.get("inCrop")
        if box and len(box) == 4:
            x, y, w, h = [float(v) * f for v in box]
            w, h = max(w, 0.0), max(h, 0.0)
            # a frame just outside the element, so its own edges stay visible
            d.rectangle([ox + x - 2, oy + y - 2, ox + x + w + 1, oy + y + h + 1], outline=FRAME, width=1)
    sheet.save(path)
    return sheet.size


def main(argv=None):
    from PIL import ImageFont

    ap = argparse.ArgumentParser()
    ap.add_argument("--crops", default=os.path.expanduser("~/vision-out/crawl"))
    ap.add_argument("--out", default=os.path.expanduser("~/vision-out/label"))
    ap.add_argument("--seed", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0, help="crops in total (0: all)")
    ap.add_argument("--quota", default="", help="crops per source, e.g. rules=800,gbt=700,random=700 (empty: no strata)")
    ap.add_argument("--per-view", type=int, default=0, help="crops per page and device at most (0: no cap)")
    ap.add_argument("--views", default="", help="build_set.mjs views.jsonl.gz; with --splits, keep only those splits")
    ap.add_argument("--splits", default="val,test", help="training-set splits whose crops are kept (with --views)")
    ap.add_argument("--per-sheet", type=int, default=COLS * ROWS)
    ap.add_argument("--width", type=int, default=1400)
    a = ap.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    sides = find_sidecars(a.crops)
    found = len(sides)
    split_of = None
    if a.views:
        split_of = allowed_views(a.views, set(a.splits.split(",")))
        sides = [s for s in sides if s.get("vid") in split_of]
    sides.sort(key=lambda s: s["id"])
    random.Random(a.seed).shuffle(sides)
    quota = parse_quota(a.quota)
    if quota:
        sides = select(sides, quota, a.per_view)
    elif a.per_view:
        sides = select(sides, [("rules", 10**9), ("gbt", 10**9), ("random", 10**9)], a.per_view)
    strata = {}
    for side in sides:
        k = side.get("_stratum") or "all"
        strata[k] = strata.get(k, 0) + 1
    if a.limit:
        sides = sides[: a.limit]
    per = max(1, min(a.per_sheet, COLS * ROWS))
    try:
        font = ImageFont.load_default(size=15)
    except TypeError:
        font = ImageFont.load_default()
    pos = layout(len(sides), per)
    sheets = []
    rows = []
    for s in range(0, len(sides), per):
        n = s // per
        cells = [(pos[s + j][1], sides[s + j]) for j in range(min(per, len(sides) - s))]
        file = f"sheet-{n:03d}.png"
        size = draw_sheet(cells, a.width, os.path.join(a.out, file), font)
        sheets.append({"file": file, "size": list(size), "cells": [{"cell": c, "id": side["id"]} for c, side in cells]})
        rows += [[side["id"], file, c, "", ""] for c, side in cells]
    json.dump({"built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": a.seed, "perSheet": per,
               "crops": len(sides), "sheets": sheets}, open(os.path.join(a.out, "index.json"), "w"), indent=1)
    # kept apart from index.json so the sheets stay blind: how many crops each stratum gave, not which crop is which
    by_split = {}
    for side in sides:
        k = split_of.get(side.get("vid"), "?") if split_of else "all"
        by_split[k] = by_split.get(k, 0) + 1
    json.dump({"crops": len(sides), "found": found, "splits": a.splits if a.views else None, "bySplit": by_split,
               "quota": dict(quota), "perView": a.per_view, "strata": strata},
              open(os.path.join(a.out, "selection.json"), "w"), indent=1)
    with open(os.path.join(a.out, "labels.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "sheet", "cell", "label", "note"])
        w.writerows(rows)
    print(f"{len(sides)} crops on {len(sheets)} sheets in {a.out}")
    return sheets


if __name__ == "__main__":
    main()
