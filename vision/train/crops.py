"""Screenshot crops of a sample of a model's flags on natural (clean) test pages, for a hand check.

    ~/vt-venv/bin/python vision/train/crops.py --model gbt --op frr-0.1% --n 100 --out ~/vision-out/crops

Takes the threshold of operating point OP from eval.json (chosen on dev), flags the natural rows of the test
split, keeps flags whose box is at least partly inside the viewport (the crawl saved viewport screenshots only),
samples N with a fixed seed, and draws each box in red on its view's screenshot (shots/<host>/<device>-<scheme>.jpg,
desktop at 0.5 and phone at 0.75 scale), 4 crops per sheet with the row's main measurements as a caption.
Writes sheet-NN.png and flags.json (one entry per crop: sheet, cell, host, view, row, score, inputs).
"""

import argparse
import glob
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from common import Cols, RULES, Split, Y_CODES, load_schema, load_views, log

SCALE = {"desktop": 0.5, "phone": 0.75}
CELL = (640, 420)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/trainset"))
    ap.add_argument("--models", default=os.path.expanduser("~/vision-out/models"))
    ap.add_argument("--crawl", default=os.path.expanduser("~/vision-out/crawl"))
    ap.add_argument("--model", default="gbt")
    ap.add_argument("--op", default="frr-0.1%")
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--seed", type=int, default=5)
    ap.add_argument("--out", default=os.path.expanduser("~/vision-out/crops"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    schema = load_schema(a.set)
    cols = Cols(schema)
    views = load_views(a.set)
    ev = json.load(open(os.path.join(a.models, "eval.json")))
    te = Split(a.set, "test", schema)
    rb = np.load(os.path.join(a.models, "rules-test.npy"))
    if a.model == "rules":  # the measured thresholds: a row is flagged when any rule fires
        thr, s = 0.5, (rb != 0).astype(np.float32)
    else:
        thr = ev["models"][a.model]["ops"][a.op]["test"]["threshold"]
        s = np.load(os.path.join(a.models, f"scores-{a.model}-test.npy"))
    nat = te.y == Y_CODES["nat"]
    flag = nat & (s >= thr)
    inview = flag & (cols(te.X, "inv") > 0)
    shots = {}
    for p in glob.glob(os.path.join(a.crawl, "shard-*", "shots", "*", "*.jpg")):
        h, f = p.split("/")[-2:]
        shots.setdefault((h, f), p)
    cand = [r for r in np.flatnonzero(inview)
            if (views[int(te.v[r])]["host"], f"{views[int(te.v[r])]['device']}-{views[int(te.v[r])]['scheme']}.jpg") in shots]
    rng = np.random.default_rng(a.seed)
    pick = sorted(rng.choice(cand, min(a.n, len(cand)), replace=False).tolist(), key=lambda r: (te.v[r], r))
    stats = {"model": a.model, "op": a.op, "threshold": thr, "naturalRows": int(nat.sum()), "flagged": int(flag.sum()),
             "flaggedInViewport": int(inview.sum()), "withScreenshot": len(cand), "sampled": len(pick),
             "flaggedViews": int(len(np.unique(te.v[flag]))), "naturalViews": int(len(np.unique(te.v[nat])))}
    log(json.dumps(stats))
    inv_tag = {v: k for k, v in schema["categorical"]["tag"].items()}
    inv_why = {v: k for k, v in schema["categorical"]["why"].items()}
    inv_pos = {v: k for k, v in schema["categorical"]["pos"].items()}
    font = ImageFont.load_default(size=13)
    entries = []
    sheet = None
    for n, r in enumerate(pick):
        vv = views[int(te.v[r])]
        dev = vv["device"]
        img = Image.open(shots[(vv["host"], f"{dev}-{vv['scheme']}.jpg")]).convert("RGB")
        k = SCALE[dev]
        g = lambda name: float(cols(te.X[r:r + 1], name)[0])
        x, y, w, h = g("x") * k, g("y") * k, g("w") * k, g("h") * k
        d = ImageDraw.Draw(img)
        d.rectangle([x - 1, y - 1, x + w + 1, y + h + 1], outline=(255, 0, 0), width=2)
        m = 90
        box = [max(0, int(x - m)), max(0, int(y - m)), min(img.width, int(x + w + m)), min(img.height, int(y + h + m))]
        if box[2] - box[0] < 40 or box[3] - box[1] < 40:
            box = [0, 0, img.width, img.height]
        crop = img.crop(box)
        cw, ch = CELL[0], CELL[1] - 46
        f = min(cw / crop.width, ch / crop.height, 3.0)
        crop = crop.resize((max(1, int(crop.width * f)), max(1, int(crop.height * f))))
        if n % 4 == 0:
            if sheet is not None:
                sheet.save(os.path.join(a.out, f"sheet-{n // 4 - 1:02d}.png"))
            sheet = Image.new("RGB", (CELL[0] * 2, CELL[1] * 2), (235, 235, 235))
        cx, cy = (n % 4) % 2 * CELL[0], (n % 4) // 2 * CELL[1]
        sheet.paste(crop, (cx, cy + 46))
        rules_hit = [RULES[b] for b in range(len(RULES)) if (int(rb[r]) >> b) & 1]
        tag = inv_tag.get(int(g("cat_tag")), "?")
        cap1 = (f"#{n} {vv['host'][:34]} {dev}-{vv['scheme']} score {s[r]:.3f} <{tag}> {g('w'):.0f}x{g('h'):.0f} "
                f"@{g('x'):.0f},{g('y'):.0f}")
        cap2 = (f"vis {g('vis'):.0f} {inv_why.get(int(g('cat_why')), '')} inv {g('inv'):.2f} op {g('op'):.2f} eop {g('eop'):.2f} "
                f"tl {g('tl'):.0f} cr {g('cr'):.2f} ebs {g('ebs'):.0f} scr {g('scr'):.2f} hs/ho {g('hs'):.0f}/{g('ho'):.0f} "
                f"pos {inv_pos.get(int(g('cat_pos')), '-')} an {g('an'):.0f}")
        cap3 = (f"iok {g('iok'):.0f} dist {g('dist'):.2f} swOver {g('swOver'):.0f} shOver {g('shOver'):.0f} tspill {g('tspill'):.0f} "
                f"cvis {g('cvis'):.2f} lk {g('lkN'):.0f} vu {g('vu'):.0f} rules {','.join(rules_hit) or '-'}")
        dd = ImageDraw.Draw(sheet)
        for j, t in enumerate((cap1, cap2, cap3)):
            dd.text((cx + 4, cy + 2 + 14 * j), t, fill=(0, 0, 0), font=font)
        dd.rectangle([cx, cy, cx + CELL[0] - 1, cy + CELL[1] - 1], outline=(120, 120, 120))
        entries.append({"n": n, "sheet": n // 4, "cell": n % 4, "host": vv["host"], "device": dev, "scheme": vv["scheme"],
                        "group": vv["group"], "domain": vv["domain"], "v": int(te.v[r]), "i": int(te.i[r]), "row": int(r),
                        "score": float(s[r]), "tag": tag, "rules": rules_hit,
                        "box": [g("x"), g("y"), g("w"), g("h")]})
    if sheet is not None:
        sheet.save(os.path.join(a.out, f"sheet-{(len(pick) - 1) // 4:02d}.png"))
    json.dump({"stats": stats, "flags": entries}, open(os.path.join(a.out, "flags.json"), "w"), indent=1)
    log(f"wrote {len(entries)} crops")


if __name__ == "__main__":
    main()
