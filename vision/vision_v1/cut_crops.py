#!/usr/bin/env python3
# Cuts the crops that crawl.mjs did not: natural elements and injected faults (with their matched clean elements),
# out of the stored viewport shots (JPEG quality 55 at 0.5x on desktop, 0.75x on phone), brought back to CSS px and
# saved as JPEG quality 92 at the item's `img` path. Runs on the data node; crops never leave it.
#
#   cut_crops.py [--procs 70]

import argparse
import collections
import json
import os
import sys
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT, cut_from_shot  # noqa: E402


def work(job):
    from PIL import Image
    shot, items = job
    n = 0
    try:
        im = Image.open(shot).convert("RGB")
    except Exception:
        return 0
    for it in items:
        if os.path.exists(it["img"]):
            n += 1
            continue
        c = cut_from_shot(im, it["crop"]["rect"], it["crop"]["viewport"][0])
        os.makedirs(os.path.dirname(it["img"]), exist_ok=True)
        c.save(it["img"], "JPEG", quality=92)
        n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--procs", type=int, default=70)
    a = ap.parse_args()
    idx = os.path.join(OUT, "index")
    shots = {}
    with open(os.path.join(idx, "shots.jsonl")) as fh:
        for line in fh:
            r = json.loads(line)
            shots[r["id"]] = r["shot"]
    by = collections.defaultdict(list)
    for name in ("nat.jsonl", "inj.jsonl"):
        with open(os.path.join(idx, name)) as fh:
            for line in fh:
                it = json.loads(line)
                if it["src"] == "shot":
                    by[shots[it["id"]]].append({"img": it["img"], "crop": it["crop"]})
    jobs = list(by.items())
    with Pool(a.procs) as pool:
        n = sum(pool.imap_unordered(work, jobs, chunksize=8))
    print(json.dumps({"shots": len(jobs), "crops": n, "items": sum(len(v) for v in by.values())}))


if __name__ == "__main__":
    main()
