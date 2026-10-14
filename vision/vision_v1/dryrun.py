#!/usr/bin/env python3
# Dry run of `evaluate.py final` on a stand-in test set: 600 candidate crops of training hosts (never the held-out
# hosts) with random strata, inclusion probabilities and labels, in a separate folder. It exercises every line of
# the final evaluation without reading a test crop or a test label.
#
#   dryrun.py --dir /tmp/vv1-dry   then   VV1_TEST_DIR=/tmp/vv1-dry evaluate.py final --model DIR

import argparse
import json
import os
import random
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT, FAMILIES  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    a = ap.parse_args()
    held = set(json.load(open(os.path.join(OUT, "test", "heldout.json")))["g"])
    nat = [json.loads(l) for l in open(os.path.join(OUT, "index", "nat.jsonl"))]
    pool = [it for it in nat if it["kind"] == "cand" and it["g"] not in held]
    rng = random.Random(0)
    rng.shuffle(pool)
    os.makedirs(a.dir, exist_ok=True)
    man, lab = [], {}
    for it in pool[:600]:
        t = secrets.token_hex(6)
        man.append({"test": t, "crop": it["id"], "stratum": rng.choice(["rules", "random", "clef-high", "clef-low"]),
                    "pi": rng.choice([0.1, 0.5, 1.0]), "g": it["g"], "rules": it.get("rules") or [], "img": it["img"]})
        v = rng.choice(["real", "not", "not", "unclear"])
        fam = rng.choice(["text", "overflow", "media", "occlusion"]) if v == "real" else "none"
        lab[t] = {"verdict": v, "family": fam, "votes": 2}
    with open(os.path.join(a.dir, "manifest.jsonl"), "w") as out:
        for m in man:
            out.write(json.dumps(m) + "\n")
    json.dump({"stats": {"dryRun": True}, "labels": lab}, open(os.path.join(a.dir, "labels.json"), "w"))
    print("stand-in test set of %d training-host crops in %s" % (len(man), a.dir))


if __name__ == "__main__":
    main()
