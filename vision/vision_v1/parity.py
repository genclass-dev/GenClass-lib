#!/usr/bin/env python3
# Checks that clef_prompt.py, fed from build_index.py's lab.jsonl, builds the same Clef requests (state and
# questions, byte for byte) as the Clef evaluation built from its own items.jsonl, and that the dev/report split and
# the bootstrap groups are the same.
#
#   parity.py --ref CLEF_WORK/items.jsonl

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT  # noqa: E402
import clef_prompt  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    a = ap.parse_args()
    ref = {}
    with open(a.ref) as fh:
        for line in fh:
            it = json.loads(line)
            ref[it["id"]] = it
    mine = {}
    with open(os.path.join(OUT, "index", "lab.jsonl")) as fh:
        for line in fh:
            it = json.loads(line)
            if it["kind"] == "lab":
                mine[it["id"]] = it
    n = {"ref": len(ref), "found": 0, "split": 0, "group": 0}
    bad = {}
    dummy = os.path.join(OUT, "parity-dummy.bin")  # the image is the same crawl crop on both sides; compare the text
    with open(dummy, "wb") as fh:
        fh.write(b"x")
    for cid, r in ref.items():
        m = mine.get(cid)
        if m is None:
            continue
        n["found"] += 1
        n["split"] += r["split"] == m["clefSplit"]
        n["group"] += r["g"] == m["g"]
        for v in ("clef-img-p3", "clef-imgonly-p2", "clef-text-p3"):
            cfg = clef_prompt.VARIANTS[v]
            rb = clef_prompt.build_request(dict(r, img=dummy), cfg)
            mb = clef_prompt.build_request(dict(m, img=dummy), cfg)
            same = rb["state"] == mb["state"] and json.dumps(rb["questions"]) == json.dumps(mb["questions"])
            n[v] = n.get(v, 0) + same
            if not same and v not in bad:
                bad[v] = cid
    print(json.dumps({"counts": n, "firstMismatch": bad}))


if __name__ == "__main__":
    main()
