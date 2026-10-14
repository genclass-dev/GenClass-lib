#!/usr/bin/env python3
# Packs every crop into the student's input once: letterboxed 224 x 128 uint8 arrays (memory-mapped), the measured
# facts, and the ids. Full-resolution crops (crawl candidates and labelled crops) also get a "degraded" copy, the
# same crop after the crawl's shot pipeline (common.degrade), so training can show either and resolution never tells
# a source apart; shot crops are already degraded.
#
#   pack.py [--procs 72]  -> OUT/pack/<set>.X.u8, <set>.Xd.u8, <set>.F.f32, <set>.json   (set: nat, inj, lab)

import argparse
import json
import os
import sys
from multiprocessing import Pool

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT, IN_W, IN_H, letterbox, degrade, facts  # noqa: E402

PD = os.path.join(OUT, "pack")


def work(job):
    from PIL import Image
    name, n, chunk = job
    X = np.memmap(os.path.join(PD, name + ".X.u8"), dtype=np.uint8, mode="r+", shape=(n, IN_H, IN_W, 3))
    Xd = np.memmap(os.path.join(PD, name + ".Xd.u8"), dtype=np.uint8, mode="r+", shape=(n, IN_H, IN_W, 3))
    bad = 0
    for k, img, device, full in chunk:
        try:
            im = Image.open(img).convert("RGB")
        except Exception:
            bad += 1
            continue
        X[k], _ = letterbox(im)
        Xd[k] = letterbox(degrade(im, device))[0] if full else X[k]
    X.flush()
    Xd.flush()
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--procs", type=int, default=72)
    ap.add_argument("--sets", default="lab,inj,nat")
    a = ap.parse_args()
    os.makedirs(PD, exist_ok=True)
    for name in a.sets.split(","):
        items = [json.loads(l) for l in open(os.path.join(OUT, "index", name + ".jsonl"))]
        n = len(items)
        for suf in (".X.u8", ".Xd.u8"):
            np.memmap(os.path.join(PD, name + suf), dtype=np.uint8, mode="w+", shape=(n, IN_H, IN_W, 3)).flush()
        F = np.stack([facts(it) for it in items]).astype(np.float32)
        F.tofile(os.path.join(PD, name + ".F.f32"))
        meta = [{k: it.get(k) for k in ("id", "kind", "vid", "i", "split", "g", "device", "scheme", "src", "stratum", "families",
                                         "recipes", "pairOf", "verdict", "family", "rules", "sources", "r2split", "clefSplit", "gbt")}
                for it in items]
        for m, it in zip(meta, items):
            m["tag"] = it["el"].get("tag")
        json.dump({"n": n, "shape": [IN_H, IN_W, 3], "facts": F.shape[1], "items": meta}, open(os.path.join(PD, name + ".json"), "w"))
        jobs = []
        step = 256
        for s in range(0, n, step):
            jobs.append((name, n, [(k, items[k]["img"], items[k]["device"], items[k]["src"] == "crawl") for k in range(s, min(n, s + step))]))
        with Pool(a.procs) as pool:
            bad = sum(pool.imap_unordered(work, jobs))
        print(json.dumps({"set": name, "n": n, "unreadable": bad}), flush=True)


if __name__ == "__main__":
    main()
