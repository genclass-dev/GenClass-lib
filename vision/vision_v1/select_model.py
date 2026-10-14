#!/usr/bin/env python3
# Model choice on dev only: for every finished run under OUT/models, the dev AP of the student's anyProblem score
# (round-2 labelled crops, full-resolution input) averaged over its last three epochs, and the run that ranks first.
# The chosen run's final checkpoint (model.pt) is the model; no epoch is picked by its own dev score.
#
#   select_model.py [--prefix f]

import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", default="f")
    a = ap.parse_args()
    rows = []
    for d in sorted(glob.glob(os.path.join(OUT, "models", "*"))):
        p = os.path.join(d, "train.json")
        if not os.path.exists(p):
            continue
        t = json.load(open(p))
        ep = t["epochs"]
        if len(ep) < 3:
            continue
        last = [e["dev"]["any"] for e in ep[-3:]]
        c = t["config"]
        rows.append({"run": os.path.basename(d), "arch": c["arch"], "epochs": len(ep), "wInj": c["w_inj"], "lr": c["lr"],
                     "anyHead": c.get("any_head", False), "trainNatural": t["trainNatural"], "trainInjected": t["trainInjected"],
                     "devApLast3": round(sum(last) / 3, 4), "devApFinal": ep[-1]["dev"]["any"],
                     "devApDegradedFinal": ep[-1]["devDegraded"]["any"], "distillCorrA": ep[-1]["distillVal"]["corrAnyA"],
                     "trainSeconds": t.get("trainSeconds")})
    rows.sort(key=lambda r: -r["devApLast3"])
    for r in rows:
        print(json.dumps(r))
    cand = [r for r in rows if r["run"].startswith(a.prefix)]
    if cand:
        print("chosen:", cand[0]["run"])
    json.dump(rows, open(os.path.join(OUT, "models", "selection-%s.json" % os.uname().nodename), "w"), indent=1)


if __name__ == "__main__":
    main()
