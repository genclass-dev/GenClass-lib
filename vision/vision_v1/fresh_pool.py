#!/usr/bin/env python3
# Counts the candidate pool for a fresh test set: natural views of round-2 val and test hosts (never trained on) that
# are not near-duplicates and have no labelled crop at all (labels.json, labels-extra.json, the round-2 hand checks),
# and the crawl's full-resolution candidate crops on them. Prints counts only.

import collections
import glob
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import B  # noqa: E402


def labelled_hosts():
    hosts = set()
    for f in ("labels.json", "labels-extra.json"):
        L = json.load(open(os.path.join(B, f)))
        for x in (L["labels"] if isinstance(L, dict) else L):
            hosts.add(x["host"])
    # the round-2 hand checks looked at flags on test pages: their hosts are not fresh either
    for f in glob.glob(os.path.join(B, "results", "handcheck-*.json")) + glob.glob(os.path.join(B, "handcheck", "*", "*.json")):
        try:
            d = json.load(open(f))
        except ValueError:
            continue
        stack = [d]
        while stack:
            x = stack.pop()
            if isinstance(x, dict):
                if isinstance(x.get("host"), str):
                    hosts.add(x["host"])
                stack.extend(x.values())
            elif isinstance(x, list):
                stack.extend(x)
    return hosts


def main():
    lab = labelled_hosts()
    views = {}
    with gzip.open(os.path.join(B, "trainset/views.jsonl.gz"), "rt") as fh:
        for line in fh:
            v = json.loads(line)
            if v["round"] == 0 and v["split"] in ("val", "test"):
                views[v["vid"]] = v
    fresh = {vid: v for vid, v in views.items() if not v.get("dup") and v["host"] not in lab and not v.get("partial")}
    hosts = {v["host"] for v in fresh.values()}
    n = collections.Counter()
    src = collections.Counter()
    for f in glob.glob(os.path.join(B, "crawl/shard-*/crops/*.json")):
        s = json.load(open(f))
        if s["vid"] in fresh:
            n["crops"] += 1
            for k in s.get("sources", []):
                src[k] += 1
    print(json.dumps({"labelledHosts": len(lab), "valTestNaturalViews": len(views), "freshViews": len(fresh), "freshHosts": len(hosts),
                      "freshBySplit": dict(collections.Counter(v["split"] for v in fresh.values())),
                      "freshByDeviceScheme": dict(collections.Counter(v["device"] + "-" + v["scheme"] for v in fresh.values())),
                      "freshGroups": dict(collections.Counter(v["group"] for v in fresh.values())),
                      "candidateCrops": n["crops"], "bySource": dict(src)}))


if __name__ == "__main__":
    main()
