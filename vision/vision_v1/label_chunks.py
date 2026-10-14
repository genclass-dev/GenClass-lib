#!/usr/bin/env python3
# Splits one labeller pass into chunks for separate agents: JPEG copies of its sheets and one CSV template per chunk
# (sheet, cell, code; verdict, family, note empty), in OUT/test/pass-<P>/out/. The code -> test id key is not copied.
#
#   label_chunks.py --pass A --chunks 6

import argparse
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT  # noqa: E402


def main():
    from PIL import Image
    ap = argparse.ArgumentParser()
    ap.add_argument("--pass", dest="p", required=True)
    ap.add_argument("--chunks", type=int, default=6)
    a = ap.parse_args()
    d = os.path.join(OUT, "test", "pass-" + a.p)
    od = os.path.join(d, "out")
    os.makedirs(od, exist_ok=True)
    rows = list(csv.DictReader(open(os.path.join(d, "labels.csv"))))
    sheets = sorted({r["sheet"] for r in rows})
    for s in sheets:
        Image.open(os.path.join(d, s)).convert("RGB").save(os.path.join(od, s.replace(".png", ".jpg")), "JPEG", quality=90)
    per = (len(sheets) + a.chunks - 1) // a.chunks
    for k in range(a.chunks):
        mine = set(sheets[k * per: (k + 1) * per])
        with open(os.path.join(od, "labels-%s%d.csv" % (a.p, k)), "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["sheet", "cell", "code", "verdict", "family", "note"])
            for r in rows:
                if r["sheet"] in mine:
                    w.writerow([r["sheet"].replace(".png", ".jpg"), r["cell"], r["code"], "", "", ""])
        print("chunk %s%d: %s .. %s (%d sheets)" % (a.p, k, min(mine), max(mine), len(mine)))


if __name__ == "__main__":
    main()
