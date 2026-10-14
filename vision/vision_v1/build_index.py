#!/usr/bin/env python3
# Chooses every crop Vision v1 uses and joins each one to its measured facts. Runs on the data node.
#
#   build_index.py [--natural 100000] [--seed 1]  -> OUT/index/{nat,inj,lab}.jsonl, OUT/index/summary.json
#
# Three sets, one JSON line per crop (the fields vision/clef/eval.py's prompt reads, plus bookkeeping):
# - nat: natural (never injected) elements of train hosts, to be labelled by Clef. First every crawl candidate crop
#   (full resolution, cut by crawl.mjs: the v1 model's top picks, v1 rule flags and random visible elements), then
#   elements cut from the natural viewport shots, stratified (text, controls, media, dark views, overlaps, small
#   elements, overflow, measured signals, random) taking turns, at most 12 per view, until --natural crops.
# - inj: fault rows of train hosts whose pixel verdict is "seen" (not noisy), at most 600 per recipe and 4 per view,
#   each with the same element in the page's natural view ("before": same tag, box IoU at least 0.3) and, in views
#   that have sampled clean rows, a matched clean element of the injected view (same tag if possible, nearest area)
#   whose crop touches no marked element. Faults with neither are left out.
# - lab: the 2,200 labelled crops of val and test hosts (evaluation only) and the 420 training-only labelled crops of
#   train hosts (labels-extra.json), with the Clef evaluation's dev/report split and the round-2 val/test split.
#
# Hosts are read here and never written: items carry a salted host hash `g` (the Clef evaluation's hash for labelled
# crops, so its bootstrap groups are reproduced), view ids and crop ids. Shot paths (which contain the host) go to a
# separate node-only file, shots.jsonl.

import argparse
import collections
import glob
import gzip
import json
import os
import random
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import B, OUT, crop_rect, eligible, num, clef_host_group, clef_is_dev, host_hash, crop_id  # noqa: E402

try:
    import orjson
    loads = orjson.loads
except ImportError:  # pragma: no cover
    loads = json.loads

STRATA = ["signal", "overflow", "dark", "media", "overlap", "small", "lowcontrast", "control", "text", "random"]
MEDIA_TAGS = {"img", "svg", "video", "canvas", "picture", "iframe", "object", "embed"}


def strata_bits(r, page, scheme):
    """Bitmask over STRATA for one eligible natural row."""
    b = 0
    vw = num(page.get("vw"), 1366) or 1366
    tag = r.get("tag", "")
    broken = tag == "img" and r.get("cmp") and not r.get("iok")
    lowc = r.get("tl") and isinstance(r.get("cr"), (int, float)) and r["cr"] < 1.5 and r.get("ebs", 0) == 0
    if broken or r.get("lk") or lowc or r.get("src") == "ph" or ((r.get("vu") or r.get("vi")) and isinstance(r.get("cr"), (int, float)) and r["cr"] < 3):
        b |= 1 << 0
    x, w = num(r.get("x")), num(r.get("w"))
    sideways = num(page.get("scrollW")) > num(page.get("clientW")) + 1
    own_ovf = r.get("sw") is not None and num(r.get("sw")) > num(r.get("cw")) + 1 and r.get("ox") in ("h", "c")
    if x + w > vw + 1 or x < -1 or num(r.get("tspill")) > 0 or own_ovf or num(r.get("cvis"), 1) < 0.98 or (sideways and x + w > vw * 0.8):
        b |= 1 << 1
    if scheme == "dark":
        b |= 1 << 2
    if tag in MEDIA_TAGS or r.get("bgi"):
        b |= 1 << 3
    if num(r.get("ho")) >= 1 or (r.get("pos") in ("a", "f") and r.get("z") is not None):
        b |= 1 << 4
    if num(r.get("w")) * num(r.get("h")) < 1024 or min(num(r.get("w")), num(r.get("h"))) < 16:
        b |= 1 << 5
    if r.get("tl") and isinstance(r.get("cr"), (int, float)) and r["cr"] < 3:
        b |= 1 << 6
    if r.get("ia"):
        b |= 1 << 7
    if r.get("tl"):
        b |= 1 << 8
    b |= 1 << 9
    return b


def iter_views(path):
    """Rows of one elements file grouped by view (crawl.mjs writes a view's rows together)."""
    cur, rows = None, []
    with gzip.open(path, "rb") as fh:
        for line in fh:
            vid = line[8: line.find(b'"', 8)].decode()
            if vid != cur:
                if rows:
                    yield cur, rows
                cur, rows = vid, []
            rows.append(line)
    if rows:
        yield cur, rows


def pass1(args):
    """Strata of every eligible row of the natural train views in one elements file: (vid, i, bits)."""
    path, nat_views = args
    out = []
    for vid, lines in iter_views(path):
        v = nat_views.get(vid)
        if v is None:
            continue
        page, scheme = v["page"] or {}, v["scheme"]
        vw, vh = num(page.get("vw"), 1366), num(page.get("vh"), 768)
        for line in lines:
            r = loads(line)
            if not eligible(r) or crop_rect(r, int(vw), int(vh)) is None:
                continue
            out.append((vid, r["i"], strata_bits(r, page, scheme)))
    return out


def payload(vr, i):
    el = vr.get(i)
    if el is None:
        return None
    anc, p = [], el.get("p", -1)
    while p is not None and p >= 0 and len(anc) < 4 and vr.get(p):
        anc.append(vr[p])
        p = vr[p].get("p", -1)
    kids = sum(1 for r in vr.values() if r.get("p") == i)
    return el, anc, min(kids, 12)


def boxes_touch(rect, b):
    x0, y0, x1, y1 = rect
    return not (b[2] <= x0 or b[0] >= x1 or b[3] <= y0 or b[1] >= y1)


def iou(a, b):
    ax0, ay0, ax1, ay1 = num(a.get("x")), num(a.get("y")), num(a.get("x")) + num(a.get("w")), num(a.get("y")) + num(a.get("h"))
    bx0, by0, bx1, by1 = num(b.get("x")), num(b.get("y")), num(b.get("x")) + num(b.get("w")), num(b.get("y")) + num(b.get("h"))
    iw, ih = max(0.0, min(ax1, bx1) - max(ax0, bx0)), max(0.0, min(ay1, by1) - max(ay0, by0))
    inter = iw * ih
    u = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / u if u > 0 else 0.0


def pass2(args):
    """Facts for every needed (vid, i) in one elements file, and for each fault row: the same element in the natural
    view of the page ("before": same tag, box IoU at least 0.3) and a clean element of the injected view ("clean":
    same tag if possible, nearest area, its crop touching no marked element; only views with sampled clean rows)."""
    path, need, faults, cleans, marked, bases = args
    got, before, matched = {}, {}, {}
    cache = collections.OrderedDict()  # natural views of the current hosts (a host's views are written together)
    for vid, lines in iter_views(path):
        if vid not in need and vid not in faults and vid not in bases:
            continue
        vr = {}
        for line in lines:
            r = loads(line)
            vr[r["i"]] = r
        if vid in bases:
            cache[vid] = vr
            while len(cache) > 12:
                cache.popitem(last=False)
        for i in need.get(vid, ()):
            pl = payload(vr, i)
            if pl:
                got[(vid, i)] = pl
        if vid in faults:
            vw, vh = faults[vid]["vp"]
            base = faults[vid]["base"]
            nvr = cache.get(base)
            used, used_b = set(), set()
            pool = [vr[i] for i in cleans.get(vid, ()) if i in vr and eligible(vr[i])]
            for fi in faults[vid]["rows"]:
                f = vr.get(fi)
                if f is None:
                    continue
                pl = payload(vr, fi)
                if pl:
                    got[(vid, fi)] = pl
                if nvr is not None:
                    best, bk = None, 0.3
                    for c in nvr.values():
                        if c.get("tag") != f.get("tag") or c["i"] in used_b or not eligible(c):
                            continue
                        k = iou(c, f)
                        if k >= bk:
                            best, bk = c, k
                    if best is not None and crop_rect(best, vw, vh) is not None:
                        used_b.add(best["i"])
                        before[(vid, fi)] = best["i"]
                        pl = payload(nvr, best["i"])
                        if pl:
                            got[(base, best["i"])] = pl
                fa = max(1.0, num(f.get("w")) * num(f.get("h")))
                best, bk = None, None
                for c in pool:
                    if c["i"] in used:
                        continue
                    rect = crop_rect(c, vw, vh)
                    if rect is None or any(boxes_touch(rect, b) for b in marked.get(vid, ())):
                        continue
                    k = (0 if c.get("tag") == f.get("tag") else 1, abs(np.log(max(1.0, num(c.get("w")) * num(c.get("h"))) / fa)))
                    if bk is None or k < bk:
                        best, bk = c, k
                if best is not None:
                    used.add(best["i"])
                    matched[(vid, fi)] = best["i"]
                    pl = payload(vr, best["i"])
                    if pl:
                        got[(vid, best["i"])] = pl
    return got, before, matched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--natural", type=int, default=100000)
    ap.add_argument("--per-view", type=int, default=12)
    ap.add_argument("--per-recipe", type=int, default=600)
    ap.add_argument("--fault-per-view", type=int, default=4)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--procs", type=int, default=8)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    od = os.path.join(OUT, "index")
    os.makedirs(od, exist_ok=True)
    summ = {}

    # ---- views: split, device, scheme, page record (trainset), pixel boxes of injected views (crawl views files)
    views, vix = {}, {}
    with gzip.open(os.path.join(B, "trainset/views.jsonl.gz"), "rb") as fh:
        for line in fh:
            v = loads(line)
            views[v["vid"]] = v
            vix[v["v"]] = v["vid"]
    pix = {}
    for f in sorted(glob.glob(os.path.join(B, "crawl/shard-*/views-*.jsonl.gz"))):
        with gzip.open(f, "rb") as fh:
            for line in fh:
                if b'"pix"' not in line:
                    continue
                v = loads(line)
                p = (v.get("injected") or {}).get("pix")
                if p:
                    pix[v["vid"]] = [e["u"] for e in p["els"] if e.get("u")]
    host_dir = {}
    for d in sorted(glob.glob(os.path.join(B, "crawl/shard-*/shots"))):
        for h in os.listdir(d):
            host_dir.setdefault(h, os.path.join(d, h))
    shots = {}
    for vid, v in views.items():
        d = host_dir.get(v["host"])
        if d:
            name = "%s-%s%s.jpg" % (v["device"], v["scheme"], "-r%d" % v["round"] if v["round"] else "")
            p = os.path.join(d, name)
            if os.path.exists(p):
                shots[vid] = p
    train_nat = {vid: v for vid, v in views.items() if v["split"] == "train" and not v.get("dup") and v["round"] == 0 and not v.get("partial")}
    summ["views"] = {"all": len(views), "trainNatural": len(train_nat), "withShot": len(shots), "withPix": len(pix)}
    print(json.dumps(summ["views"]), flush=True)

    # ---- crawl candidate crops (sidecars)
    side = {}
    for f in glob.glob(os.path.join(B, "crawl/shard-*/crops/*.json")):
        s = json.load(open(f))
        s["path"] = f[:-5] + ".jpg"
        side[s["id"]] = s

    # ---- labelled crops
    lab = json.load(open(os.path.join(B, "labels.json")))["labels"]
    labx = json.load(open(os.path.join(B, "labels-extra.json")))
    labx = labx["labels"] if isinstance(labx, dict) else labx
    lab_ids = {x["id"] for x in lab} | {x["id"] for x in labx}

    # ---- natural set: candidate crops of train views first
    nat_items = []
    taken = set()
    for cid, s in side.items():
        v = train_nat.get(s["vid"])
        if v is None:
            continue
        nat_items.append({"id": cid, "kind": "cand", "vid": s["vid"], "i": s["i"], "src": "crawl", "sources": s.get("sources", []),
                          "rules": s.get("rules", []), "crop": {"size": s["cropSize"], "inCrop": s["inCrop"], "viewport": s["viewport"], "rect": s["crop"]},
                          "img": s["path"]})
        taken.add((s["vid"], s["i"]))
    n_cand = len(nat_items)
    print("candidate crops on train views: %d" % n_cand, flush=True)

    files = sorted(glob.glob(os.path.join(B, "crawl/shard-*/elements-*.jsonl.gz")))
    with Pool(a.procs) as pool:
        parts = pool.map(pass1, [(f, train_nat) for f in files])
    pool_rows = [r for p in parts for r in p if (r[0], r[1]) not in taken and r[0] in shots]
    counts = {s: sum(1 for r in pool_rows if r[2] >> k & 1) for k, s in enumerate(STRATA)}
    summ["eligibleNaturalRows"] = {"all": len(pool_rows), "byStratum": counts}
    print(json.dumps(summ["eligibleNaturalRows"]), flush=True)

    # stratified fill: the strata take turns (one crop each per turn) so each gets an equal share until it runs out;
    # at most per-view crops per view, the crawl's candidate crops included
    want = max(0, a.natural - n_cand)
    per_view = collections.Counter(s["vid"] for s in nat_items)
    chosen = {}
    by_s = {s: [] for s in STRATA}
    for r in pool_rows:
        for k, s in enumerate(STRATA):
            if r[2] >> k & 1:
                by_s[s].append(r)
    pos = {s: 0 for s in STRATA}
    for s in STRATA:
        rng.shuffle(by_s[s])
    live = list(STRATA)
    while len(chosen) < want and live:
        for s in list(live):
            lst, k = by_s[s], pos[s]
            while k < len(lst) and ((lst[k][0], lst[k][1]) in chosen or per_view[lst[k][0]] >= a.per_view):
                k += 1
            if k >= len(lst):
                live.remove(s)
                pos[s] = k
                continue
            vid, i, _ = lst[k]
            chosen[(vid, i)] = s
            per_view[vid] += 1
            pos[s] = k + 1
            if len(chosen) >= want:
                break
    summ["naturalFromShots"] = dict(collections.Counter(chosen.values()))
    print("from shots: %s" % json.dumps(summ["naturalFromShots"]), flush=True)
    for (vid, i), s in chosen.items():
        nat_items.append({"id": crop_id("nat", vid, i), "kind": "nat", "vid": vid, "i": i, "src": "shot", "stratum": s})

    # ---- injected faults: seen, not noisy, train hosts
    fault_rows, clean_rows = collections.defaultdict(list), collections.defaultdict(list)
    per_recipe = collections.Counter()
    fault_meta = {}
    cand = []
    with gzip.open(os.path.join(B, "trainset/meta-train.jsonl.gz"), "rb") as fh:
        for line in fh:
            if b'"fault"' in line:
                m = loads(line)
                if m.get("pv") == "seen" and not m.get("noisy") and (m.get("a") or ["target"])[0] == "target":
                    cand.append(m)
            elif b'"clean"' in line:
                m = loads(line)
                clean_rows[vix[m["v"]]].append(m["i"])
    rng.shuffle(cand)
    for m in cand:
        vid = vix[m["v"]]
        v = views[vid]
        base = vid.rsplit("-r", 1)[0]
        if v["split"] != "train" or v.get("dup") or vid not in shots or base not in train_nat or base not in shots:
            continue
        r = m["r"][0]
        if per_recipe[r] >= a.per_recipe or len(fault_rows[vid]) >= a.fault_per_view:
            continue
        per_recipe[r] += 1
        fault_rows[vid].append(m["i"])
        fault_meta[(vid, m["i"])] = m
    faults = {vid: {"rows": rows, "base": vid.rsplit("-r", 1)[0],
                    "vp": (int(num((views[vid]["page"] or {}).get("vw"), 1366)), int(num((views[vid]["page"] or {}).get("vh"), 768)))}
              for vid, rows in fault_rows.items()}
    summ["faultsChosen"] = {"rows": len(fault_meta), "views": len(faults), "recipes": len(per_recipe)}
    print(json.dumps(summ["faultsChosen"]), flush=True)

    # ---- pass 2: facts for everything, matched clean rows
    need = collections.defaultdict(set)
    for it in nat_items:
        need[it["vid"]].add(it["i"])
    for x in list(lab) + list(labx):
        need[x["vid"]].add(x["i"])
    bases = {f["base"] for f in faults.values()}
    with Pool(a.procs) as pool:
        parts = pool.map(pass2, [(f, need, faults, clean_rows, pix, bases) for f in files])
    got, before, matched = {}, {}, {}
    for g, b, m in parts:
        got.update(g)
        before.update(b)
        matched.update(m)

    def fill(it, vid, i):
        v = views[vid]
        pl = got.get((vid, i))
        if pl is None:
            return None
        el, anc, kids = pl
        page = v["page"] or {}
        it.update({"split": v["split"], "g": host_hash(v["host"]), "device": v["device"], "scheme": v["scheme"], "group": v["group"],
                   "el": el, "anc": anc, "kids": kids, "page": page})
        if "crop" not in it:
            vw, vh = int(num(page.get("vw"), 1366)), int(num(page.get("vh"), 768))
            rect = crop_rect(el, vw, vh)
            if rect is None:
                return None
            x0, y0, x1, y1 = rect
            it["crop"] = {"size": [x1 - x0, y1 - y0], "inCrop": [round((el["x"] - x0) * 10) / 10, round((el["y"] - y0) * 10) / 10, el["w"], el["h"]],
                          "viewport": [vw, vh], "rect": rect}
            it["img"] = os.path.join(OUT, "crops", it["id"][:3], it["id"] + ".jpg")
        return it

    shot_index = {}
    n = collections.Counter()
    with open(os.path.join(od, "nat.jsonl"), "w") as out:
        for it in nat_items:
            it = fill(it, it["vid"], it["i"])
            if it is None:
                n["natMissing"] += 1
                continue
            if it["src"] == "shot":
                shot_index[it["id"]] = shots[it["vid"]]
            out.write(json.dumps(it) + "\n")
            n["nat"] += 1
            n["nat-" + it["kind"]] += 1
    with open(os.path.join(od, "inj.jsonl"), "w") as out:
        for (vid, fi), m in fault_meta.items():
            bi, ci = before.get((vid, fi)), matched.get((vid, fi))
            if bi is None and ci is None:
                n["faultNoPair"] += 1
                continue
            f = fill({"id": crop_id("fault", vid, fi), "kind": "fault", "vid": vid, "i": fi, "src": "shot", "recipes": m["r"],
                      "families": m["f"], "catalog": m.get("c"), "pa": m.get("pa"), "pn": m.get("pn")}, vid, fi)
            if f is None:
                n["faultMissing"] += 1
                continue
            pairs = []
            base = faults[vid]["base"]
            if bi is not None:
                b = fill({"id": crop_id("before", vid, fi), "kind": "before", "vid": base, "i": bi, "src": "shot", "pairOf": f["id"]}, base, bi)
                if b is not None:
                    pairs.append((b, shots[base]))
            if ci is not None:
                c = fill({"id": crop_id("clean", vid, ci), "kind": "clean", "vid": vid, "i": ci, "src": "shot", "pairOf": f["id"]}, vid, ci)
                if c is not None:
                    pairs.append((c, shots[vid]))
            if not pairs:
                n["faultMissing"] += 1
                continue
            shot_index[f["id"]] = shots[vid]
            out.write(json.dumps(f) + "\n")
            n["fault"] += 1
            for it, sp in pairs:
                shot_index[it["id"]] = sp
                out.write(json.dumps(it) + "\n")
                n[it["kind"]] += 1
    with open(os.path.join(od, "lab.jsonl"), "w") as out:
        for kind, xs in (("lab", lab), ("labx", labx)):
            for x in xs:
                s = side.get(x["id"])
                if s is None:
                    n[kind + "NoCrop"] += 1
                    continue
                it = {"id": x["id"], "kind": kind, "vid": x["vid"], "i": x["i"], "src": "crawl", "verdict": x["verdict"],
                      "family": x["family"], "stratum": x.get("stratum"), "sources": x.get("sources", []), "rules": x.get("rules", []),
                      "r2split": x.get("split"), "crop": {"size": s["cropSize"], "inCrop": s["inCrop"], "viewport": s["viewport"], "rect": s["crop"]},
                      "img": s["path"]}
                it = fill(it, x["vid"], x["i"])
                if it is None:
                    n[kind + "Missing"] += 1
                    continue
                # the Clef evaluation's split and bootstrap group, from the label's host
                it["clefSplit"] = "dev" if clef_is_dev(x["host"]) else "report"
                it["g"] = clef_host_group(x["host"])
                it["gbt"] = s.get("score")
                out.write(json.dumps(it) + "\n")
                n[kind] += 1
    with open(os.path.join(od, "shots.jsonl"), "w") as out:  # node-only: shot paths name hosts
        for cid, p in shot_index.items():
            out.write(json.dumps({"id": cid, "shot": p}) + "\n")
    summ["written"] = dict(n)
    summ["faultsByFamily"] = dict(collections.Counter(fault_meta[k]["f"][0] for k in fault_meta if k in matched or k in before))
    json.dump(summ, open(os.path.join(od, "summary.json"), "w"), indent=1)
    print(json.dumps(summ["written"]))


if __name__ == "__main__":
    main()
