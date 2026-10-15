#!/usr/bin/env python3
# Parity fixtures for GenClass Vision in the scanner (src/vision.ts, src/vision-page.ts, test/vision.test.ts): synthetic
# images and synthetic element rows (made up here, never crawled), with what the reference scorer makes of them.
#
# The reference is vision/vision_v2/portable/score_onnx.py (branch wave2/vision-v2-student), imported as it is: its
# letterbox() and facts() are the model's input contract (spec.json). This script never copies them.
#
#   vision-fixtures.py images --out DIR                       # DIR/<name>.png (lossless) and DIR/items.jsonl (the
#                                                            # items with an image, the scorer's input)
#   vision-fixtures.py expect --scorer score_onnx.py --dir DIR --out expect.json
#                                                            # letterbox placement + sha256 of the 224x128 RGB input,
#                                                            # and the 64 facts, per item (numpy, Pillow)
#   score_onnx.py --model model.onnx --items DIR/items.jsonl --out DIR/scores.jsonl   # needs the private model
#   vision-fixtures.py merge --expect expect.json [--scores DIR/scores.jsonl] --out test/vision-fixtures.json
#
# The pixels come from integer formulas (pixel() below) that test/vision.test.ts repeats in TypeScript, so the test
# needs no image files: it rebuilds each image, letterboxes it with the scanner's code and compares the sha256.

import argparse
import hashlib
import importlib.util
import json
import os

IMAGES = [
    # name, width, height, pattern, seed: chosen for the letterbox's cases (bicubic up to the 2.0 cap, bilinear down,
    # an exact fit that is copied, a 4 px crop, a half that Python rounds to even, wide and tall crops)
    ("btn-small", 48, 30, "ui", 0),
    ("card", 200, 100, "ui", 2),
    ("banner", 400, 90, "ui", 4),
    ("wide", 1366, 300, "ui", 6),
    ("tall", 120, 700, "stripes", 3),
    ("exact", 224, 128, "noise", 5),
    ("tiny", 4, 4, "noise", 9),
    ("phone", 390, 844, "ui", 8),
    ("near", 300, 171, "grad", 1),
    ("double", 112, 64, "ui", 10),
    ("odd", 333, 77, "noise", 12),
    ("square", 150, 150, "ui", 14),
    ("half-even", 101, 256, "stripes", 7),
    ("faint-text", 260, 60, "ui", 2),
    ("dark-btn", 180, 48, "ui", 3),
    ("dark-faint", 640, 360, "ui", 1),
]


def pixel(kind, x, y, w, h, seed):
    """One RGB pixel of a synthetic image; integers only, so TypeScript can repeat it exactly."""
    if kind == "grad":
        return ((x * 255) // max(1, w - 1), (y * 255) // max(1, h - 1), ((x + y) * (seed % 7 + 1)) % 256)
    if kind == "noise":
        v = ((x * 73856093) ^ (y * 19349663) ^ (seed * 83492791)) & 0xFFFFFF
        return (v & 255, (v >> 8) & 255, (v >> 16) & 255)
    if kind == "stripes":
        return (230, 230, 230) if ((x // 3) + (y // 7) + seed) % 2 == 0 else (20 + seed % 50, 40, 90)
    # "ui": a page fragment: text lines, a button with a label when there is room, an image block when wide; seed bit 0
    # dark scheme, bit 1 faint text
    dark = seed % 2 == 1
    faint = (seed // 2) % 2 == 1
    bg = (24, 26, 32) if dark else (250, 250, 248)
    fg = ((40, 42, 48) if faint else (220, 222, 228)) if dark else ((236, 236, 232) if faint else (28, 30, 36))
    bx0, by0, bx1, by1 = w // 6, h // 3, w - w // 6, h - h // 3
    if w >= 40 and h >= 24 and bx0 <= x < bx1 and by0 <= y < by1:
        if x == bx0 or x == bx1 - 1 or y == by0 or y == by1 - 1:
            return (20, 60, 160)
        gx = x - bx0 - 4
        gy = y - by0 - (by1 - by0) // 2 + 3
        if 0 <= gy < 7 and 0 <= gx < (bx1 - bx0) - 8 and gx % 7 < 5 and ((gx // 7) * 2654435761 + seed) % 5 != 0:
            return (255, 255, 255)
        return (37, 99, 235)
    if w >= 160 and x >= (w * 3) // 4 and 4 <= y < h - 4:
        return ((x * 3 + seed * 11) % 256, (y * 5) % 256, 160)
    ly = y % 14
    if 3 <= ly < 11 and x >= 4:
        gx = x - 4
        if gx % 7 < 5 and ((gx // 7) * 2654435761 + (y // 14) * 97 + seed) % 6 != 0:
            return fg
    return bg


def image(kind, w, h, seed):
    import numpy as np
    a = np.zeros((h, w, 3), dtype=np.uint8)
    for y in range(h):
        for x in range(w):
            a[y, x] = pixel(kind, x, y, w, h, seed)
    return a


PAGE_D = {"vw": 1366, "vh": 768, "scrollW": 1366, "clientW": 1366, "appDark": 0, "res": {"imgFailed": 0, "cssFailed": 0, "fontFailed": 0}}
PAGE_P = {"vw": 390, "vh": 844, "scrollW": 412, "clientW": 390, "appDark": 0, "res": {"imgFailed": 1, "cssFailed": 1, "fontFailed": 0}}
PAGE_PD = {"vw": 390, "vh": 844, "scrollW": 390, "clientW": 390, "appDark": 1, "res": {"imgFailed": 0, "cssFailed": 0, "fontFailed": 2}}

# element rows in the shape of vision/src/extract.js (vision-extract-2), values made up to reach every branch of facts()
ROWS = [
    {"tag": "button", "role": "button", "x": 520.5, "y": 300.2, "w": 140, "h": 44, "inv": 1, "vis": 1, "ia": 1, "cur": 1, "tl": 7, "tt": 7, "fs": 15, "cr": 4.52, "scr": 4.6, "hs": 5, "pos": "r"},
    {"tag": "p", "x": 24, "y": 120, "w": 600, "h": 48, "inv": 1, "vis": 1, "tl": 140, "tt": 140, "fs": 16, "cr": 1.08, "ebs": 0, "scr": 1.07, "sbs": 0, "hs": 5, "ln": 2},
    {"tag": "img", "x": 900, "y": 40, "w": 320, "h": 180, "inv": 1, "vis": 1, "cmp": 1, "iok": 0, "nw": 0, "nh": 0, "alt": -1, "src": "cross", "hs": 5},
    {"tag": "img", "x": 10, "y": 500, "w": 300, "h": 120, "inv": 0.6, "vis": 1, "cmp": 1, "iok": 1, "nw": 800, "nh": 600, "alt": 12, "dist": 0.78, "hs": 3, "hn": 2},
    {"tag": "a", "role": "link", "x": 30, "y": 790, "w": 60, "h": 18, "inv": 0.5, "vis": 1, "ia": 1, "cur": 1, "tl": 5, "tt": 5, "fs": 14, "cr": 7.1, "scr": 7.1, "ho": 5, "pos": "s", "z": 0},
    {"tag": "input", "role": "textbox", "x": 100, "y": 200, "w": 240, "h": 36, "inv": 1, "vis": 1, "ia": 1, "fs": 16, "hs": 4, "ha": 1, "dis": 1, "pen": 1},
    {"tag": "div", "x": -40, "y": 0, "w": 1500, "h": 400, "inv": 0.88, "vis": 1, "sw": 1500, "cw": 1366, "sh": 400, "ch": 400, "ox": "h", "nca": 2, "cvis": 0.91, "pos": "a", "tf": 1, "flt": 1, "an": 1, "bgi": 3, "ebs": 2},
    {"tag": "span", "x": 200, "y": 64, "w": 90, "h": 20, "inv": 1, "vis": 1, "tl": 9, "tt": 9, "fs": 12, "cr": 2.1, "tspill": 34.5, "lk": [["currency-nan", "$NaN"]], "eop": 0.5, "op": 0.8},
    {"tag": "svg", "x": 10, "y": 10, "w": 24, "h": 24, "inv": 1, "vis": 1, "hs": 5, "z": 10, "clip": 1},
    {"tag": "video", "x": 0, "y": 300, "w": 390, "h": 220, "inv": 1, "vis": 1, "hs": 5, "cpath": 1},
    {"tag": "h1", "x": 16, "y": 80, "w": 358, "h": 76, "inv": 1, "vis": 1, "tl": 32, "tt": 32, "fs": 32, "scr": 1.2, "sbs": 0, "vu": 2, "vp": ["color"], "hs": 5},
    {"tag": "label", "x": 16, "y": 400, "w": 120, "h": 20, "inv": 1, "vis": 1, "tl": 11, "tt": 11, "fs": 13, "cr": 1.0, "ebs": 1, "vi": 1, "hs": 5},
    {"tag": "section", "x": 0, "y": 0, "w": 390, "h": 844, "inv": 1, "vis": 1, "tt": 2400, "sw": 390, "cw": 390, "sh": 2600, "ch": 844, "oy": "a"},
    {"tag": "path", "x": 50, "y": 50, "w": 12, "h": 12, "inv": 1, "vis": 1},
    {"tag": "textarea", "x": 20, "y": 600, "w": 350, "h": 120, "inv": 1, "vis": 1, "ia": 1, "fs": 15, "hs": 0, "hn": 5, "eop": 0, "ebs": 4},
    {"tag": "li", "x": 1300, "y": 700, "w": 200, "h": 30, "inv": 0.33, "vis": 1, "tl": 3, "tt": 3, "fs": 18, "cr": 21, "scr": 30, "ho": 2, "hs": 3, "pos": "f", "z": -1},
    {"tag": "canvas", "x": 0, "y": 0, "w": 1366, "h": 768, "inv": 1, "vis": 1, "rw": 1366},
    {"tag": "b", "x": 5.25, "y": 5.75, "w": 0.5, "h": 4, "inv": 1, "vis": 1, "tl": 1, "tt": 1, "fs": 0},
]


def items(out_dir):
    """Image items (one row each, paired in order) for the model; extra rows for the facts only."""
    pages = [(PAGE_D, "desktop", "light"), (PAGE_P, "phone", "light"), (PAGE_PD, "phone", "dark")]
    out = []
    for k, row in enumerate(ROWS):
        page, device, scheme = pages[k % 3]
        img = IMAGES[k] if k < len(IMAGES) else None
        if img:
            w, h = img[1], img[2]
            size = [w, h]
            in_crop = [min(24, w // 4), min(24, h // 4), max(1, w - 48), max(1, h - 48)]
        else:
            size = [int(row["w"]) + 48, int(row["h"]) + 48]
            in_crop = [24, 24, row["w"], row["h"]]
        it = {"id": "f%02d" % k, "device": device, "scheme": scheme, "page": page, "el": row, "kids": [0, 3, 12, 40][k % 4],
              "crop": {"size": size, "inCrop": in_crop}}
        if img:
            it["img"] = os.path.join(out_dir, img[0] + ".png")
            it["image"] = img[0]
        out.append(it)
    return out


def load_scorer(path):
    spec = importlib.util.spec_from_file_location("score_onnx", path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["images", "expect", "merge"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--dir", default="")
    ap.add_argument("--scorer", default="")
    ap.add_argument("--expect", default="")
    ap.add_argument("--scores", default="")
    a = ap.parse_args()
    if a.cmd == "images":
        from PIL import Image
        os.makedirs(a.out, exist_ok=True)
        for name, w, h, kind, seed in IMAGES:
            Image.fromarray(image(kind, w, h, seed), "RGB").save(os.path.join(a.out, name + ".png"))
        with open(os.path.join(a.out, "items.jsonl"), "w") as f:
            for it in items(a.out):
                if "img" in it:  # the scorer's input: the items with an image
                    f.write(json.dumps(it) + "\n")
        print("wrote %d images and %d items to %s" % (len(IMAGES), len(ROWS), a.out))
        return
    if a.cmd == "expect":
        import numpy as np
        import PIL
        from PIL import Image
        sc = load_scorer(a.scorer)
        res = {"pillow": PIL.__version__, "numpy": np.__version__, "images": [], "facts": []}
        for name, w, h, kind, seed in IMAGES:
            arr, (s, dx, dy) = sc.letterbox(Image.open(os.path.join(a.dir, name + ".png")).convert("RGB"), 224, 128)
            nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
            res["images"].append({"name": name, "w": w, "h": h, "pattern": kind, "seed": seed, "nw": nw, "nh": nh, "dx": dx, "dy": dy,
                                  "filter": "bicubic" if s > 1 else "bilinear", "sha256": hashlib.sha256(np.ascontiguousarray(arr).tobytes()).hexdigest(),
                                  "sum": int(arr.astype(np.int64).sum())})
        for it in items(a.dir):
            f = sc.facts(it)
            res["facts"].append({"id": it["id"], "facts": [float(v) for v in f]})
        json.dump(res, open(a.out, "w"), indent=1)
        print("pillow %s numpy %s: %d images, %d fact rows" % (PIL.__version__, np.__version__, len(res["images"]), len(res["facts"])))
        return
    ex = json.load(open(a.expect))
    its = items("")
    for it in its:
        it.pop("img", None)
    scores = {}
    if a.scores:
        for line in open(a.scores):
            r = json.loads(line)
            scores[r["id"]] = {"any": r["any"], "family": r["family"], "verdict": r["verdict"]}
    facts = {r["id"]: r["facts"] for r in ex["facts"]}
    out = {
        "about": "Synthetic parity fixtures for GenClass Vision (scripts/vision-fixtures.py): made-up images and element rows, "
                 "and what vision/vision_v2/portable/score_onnx.py makes of them. Nothing here was crawled.",
        "reference": {"scorer": "vision/vision_v2/portable/score_onnx.py (wave2/vision-v2-student)", "pillow": ex["pillow"], "numpy": ex["numpy"]},
        "images": ex["images"],
        "items": [dict(it, facts=facts[it["id"]], **({"score": scores[it["id"]]} if it["id"] in scores else {})) for it in its],
    }
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print("wrote %s: %d images, %d items, %d with model scores" % (a.out, len(out["images"]), len(out["items"]), len(scores)))


if __name__ == "__main__":
    main()
