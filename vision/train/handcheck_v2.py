"""Blind hand check of v2 flags on natural test pages that are not in the labelled set (on the node).

    ~/vt-venv/bin/python vision/train/handcheck_v2.py sheets --families media,overflow --n 30 \
        --out ~/vision-out/v2/handcheck
    ~/vt-venv/bin/python vision/train/handcheck_v2.py score --out ~/vision-out/v2/handcheck --verdicts verdicts.json

sheets: for each family, a seeded sample of N of the family model's flags at its ship threshold (eval-v2.json) or at
--op, and N of the rule flags of that family; with --hybrid, for each hybrid target (eval-v2.json "hybrid"), N rule
flags the v2 score kept and N it dropped; among natural test rows whose box is at least partly in the viewport and which
are not labelled crops. Both lists are merged (a row flagged by both counts once and for both), shuffled, and drawn
from the view's screenshot (desktop at 0.5, phone at 0.75 scale) with a magenta frame just outside the box, 12 per
sheet, each cell numbered h0001... with nothing that says which source flagged it or its score. key.json (node only)
maps each number to the row, the sources and the view. score: reads verdicts (real, unclear, not per number) and
writes handcheck.json: per family and source, flags checked, real, unclear, not and the precision.
"""

import argparse
import glob
import json
import os
import random
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import RULES, Cols, Split, Y_CODES, load_schema, load_views, log, rules  # noqa: E402
from eval_v2 import RULE_FAMILY  # noqa: E402

SCALE = {"desktop": 0.5, "phone": 0.75}
COLS, ROWS = 3, 4
CW, CH, CAP = 460, 380, 22
FRAME = (230, 0, 160)


def cmd_sheets(a):
    from PIL import Image, ImageDraw, ImageFont

    schema = load_schema(a.set)
    cols = Cols(schema)
    views = load_views(a.set)
    te = Split(a.set, "test", schema)
    ev = json.load(open(os.path.join(a.models, "eval-v2.json")))
    lab = json.load(open(a.labels))["labels"]
    labelled = {e["row"] for e in lab if e["split"] == "test"}
    rb = rules(te, cols, views)
    shots = {}
    for p in glob.glob(os.path.join(a.crawl, "shard-*", "shots", "*", "*.jpg")):
        h, f = p.split("/")[-2:]
        shots.setdefault((h, f), p)
    nat = te.y == Y_CODES["nat"]
    ok = nat & (cols(te.X, "inv") > 0) & (cols(te.X, "vis") == 1)
    ok[list(labelled)] = False
    has_shot = np.array([(views[int(v)]["host"], f"{views[int(v)]['device']}-{views[int(v)]['scheme']}.jpg") in shots
                         for v in range(int(te.v.max()) + 1)])
    ok &= has_shot[te.v]
    rng = np.random.default_rng(a.seed)
    picks = {}  # row -> set of sources
    stats = {}
    for fam in [f for f in a.hybrid.split(",") if f]:
        h = ev["hybrid"]["families"].get(fam) or ev["hybrid"]["rules"].get(fam)
        if not h or not h.get("chosen"):
            continue
        bits = sum(1 << RULES.index(r) for r, rf in RULE_FAMILY.items() if rf == fam) if fam in ev["hybrid"]["families"] \
            else 1 << RULES.index(fam)
        rule = (rb & bits) != 0
        sc = np.load(os.path.join(a.models, f"scores-{h['chosen']['score']}-test.npy"))
        kept = rule & (sc >= h["chosen"]["threshold"])
        for name, flag in ((f"hybrid:{fam}", kept), (f"rejected:{fam}", rule & ~kept)):
            cand = np.flatnonzero(flag & ok)
            take = rng.choice(cand, min(a.n, len(cand)), replace=False) if len(cand) else []
            stats[name] = {"threshold": h["chosen"]["threshold"], "score": h["chosen"]["score"],
                           "flaggedNatural": int((flag & nat).sum()), "eligible": int(len(cand)), "sampled": int(len(take))}
            for r in take:
                picks.setdefault(int(r), set()).add(name)
    for fam in [f for f in a.families.split(",") if f]:
        tag = fam if fam in ev["models"] else None
        srcs = {}
        if tag and "ship" in ev["models"][tag]["ops"] and not a.op:
            thr = ev["models"][tag]["ops"]["ship"]["threshold"]
            srcs[f"model:{fam}"] = (np.load(os.path.join(a.models, f"scores-{tag}-test.npy")) >= thr, thr)
        elif tag and a.op:
            thr = ev["models"][tag]["ops"][a.op]["threshold"]
            srcs[f"model:{fam}"] = (np.load(os.path.join(a.models, f"scores-{tag}-test.npy")) >= thr, thr)
        bits = sum(1 << RULES.index(r) for r, rf in RULE_FAMILY.items() if rf == fam)
        if bits:
            srcs[f"rules:{fam}"] = ((rb & bits) != 0, None)
        for name, (flag, thr) in srcs.items():
            cand = np.flatnonzero(flag & ok)
            take = rng.choice(cand, min(a.n, len(cand)), replace=False) if len(cand) else []
            stats[name] = {"threshold": thr, "flaggedNatural": int((flag & nat).sum()), "eligible": int(len(cand)),
                           "sampled": int(len(take))}
            for r in take:
                picks.setdefault(int(r), set()).add(name)
    rows = sorted(picks)
    random.Random(a.seed).shuffle(rows)
    os.makedirs(a.out, exist_ok=True)
    try:
        font = ImageFont.load_default(size=15)
    except TypeError:
        font = ImageFont.load_default()
    key = []
    sheet = None
    for n, r in enumerate(rows):
        vv = views[int(te.v[r])]
        img = Image.open(shots[(vv["host"], f"{vv['device']}-{vv['scheme']}.jpg")]).convert("RGB")
        k = SCALE[vv["device"]]
        g = lambda name: float(cols(te.X[r:r + 1], name)[0])
        x, y, w, h = g("x") * k, g("y") * k, g("w") * k, g("h") * k
        m = 60
        box = [max(0, int(x - m)), max(0, int(y - m)), min(img.width, int(x + w + m)), min(img.height, int(y + h + m))]
        if box[2] - box[0] < 30 or box[3] - box[1] < 30:
            box = [0, 0, img.width, img.height]
        crop = img.crop(box)
        f = min(CW / crop.width, (CH - CAP) / crop.height, 4.0)
        crop = crop.resize((max(1, int(crop.width * f)), max(1, int(crop.height * f))))
        if n % (COLS * ROWS) == 0:
            if sheet is not None:
                sheet.save(os.path.join(a.out, f"hc-{n // (COLS * ROWS) - 1:03d}.png"))
            sheet = Image.new("RGB", (CW * COLS, CH * ROWS), (236, 236, 236))
        c = n % (COLS * ROWS)
        cx, cy = (c % COLS) * CW, (c // COLS) * CH
        ox, oy = cx + (CW - crop.width) // 2, cy + CAP + (CH - CAP - crop.height) // 2
        sheet.paste(crop, (ox, oy))
        d = ImageDraw.Draw(sheet)
        bx, by = (x - box[0]) * f + ox, (y - box[1]) * f + oy
        d.rectangle([bx - 2, by - 2, bx + w * f + 1, by + h * f + 1], outline=FRAME, width=2)
        d.rectangle([cx, cy, cx + CW - 1, cy + CH - 1], outline=(150, 150, 150))
        hid = f"h{n + 1:04d}"
        d.text((cx + 6, cy + 3), f"{hid}  {vv['device']}-{vv['scheme']}", fill=(0, 0, 0), font=font)
        key.append({"id": hid, "row": int(r), "sources": sorted(picks[r]), "v": int(te.v[r]), "i": int(te.i[r]),
                    "host": vv["host"], "device": vv["device"], "scheme": vv["scheme"], "group": vv["group"],
                    "sheet": n // (COLS * ROWS), "cell": c + 1,
                    "rules": [RULES[b] for b in range(len(RULES)) if (int(rb[r]) >> b) & 1]})
    if sheet is not None:
        sheet.save(os.path.join(a.out, f"hc-{(len(rows) - 1) // (COLS * ROWS):03d}.png"))
    json.dump({"stats": stats, "key": key}, open(os.path.join(a.out, "key.json"), "w"), indent=1)
    log(f"{len(rows)} crops on {(len(rows) + COLS * ROWS - 1) // (COLS * ROWS)} sheets; {json.dumps(stats)}")


def cmd_score(a):
    K = json.load(open(os.path.join(a.out, "key.json")))
    V = json.load(open(a.verdicts))  # {hid: verdict} or {hid: [verdict, note]}
    res = {}
    for e in K["key"]:
        vd = V.get(e["id"])
        if vd is None:
            continue
        vd = vd[0] if isinstance(vd, list) else vd
        for s in e["sources"]:
            b = res.setdefault(s, {"checked": 0, "real": 0, "unclear": 0, "not": 0})
            b["checked"] += 1
            b[vd] += 1
    for s, b in res.items():
        b["precision"] = round(b["real"] / b["checked"], 4) if b["checked"] else None
        b.update(K["stats"].get(s, {}))
    json.dump({"bySource": res, "stats": K["stats"]}, open(os.path.join(a.out, "handcheck.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["sheets", "score"])
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/v2/trainset"))
    ap.add_argument("--labels", default=os.path.expanduser("~/vision-out/v2/labels.json"))
    ap.add_argument("--models", default=os.path.expanduser("~/vision-out/v2/models/v2"))
    ap.add_argument("--crawl", default=os.path.expanduser("~/vision-out/v2/crawl"))
    ap.add_argument("--out", default=os.path.expanduser("~/vision-out/v2/handcheck"))
    ap.add_argument("--families", default="", help="model:<family> (ship point or --op) and rules:<family> flags")
    ap.add_argument("--hybrid", default="", help="hybrid:<target> (kept rule flags) and rejected:<target> (dropped) flags")
    ap.add_argument("--op", default="", help="operating point instead of ship (e.g. frr-0.1%%)")
    ap.add_argument("--n", type=int, default=30)
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--verdicts", default="")
    a = ap.parse_args()
    {"sheets": cmd_sheets, "score": cmd_score}[a.cmd](a)


if __name__ == "__main__":
    main()
