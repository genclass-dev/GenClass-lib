#!/usr/bin/env python3
# Node side of the OpenAI labelling of the 100,000 natural crops (OpenAI's key stays on the Mac, so the Mac sends the
# calls and the node builds them).
#
#   oa_requests.py plan [--size 2000] [--seed 3]   the 100,000 crops of Vision v1's nat index in batches: OUT/oa/plan.json
#                                                  and OUT/oa/items/items-K.jsonl (node-only index rows per batch)
#   oa_requests.py make --batch K                  gzip JSONL on stdout, one {"t": token, "body": request} per crop;
#                                                  the token -> crop id key is written to OUT/oa/keys/key-K.json
#   oa_requests.py collect                         answers pushed back by the Mac (OUT/oa/answers/answers-K.jsonl)
#                                                  joined with the keys -> OUT/oa/luna-img-p3.jsonl {id, verdict, family}
#   oa_requests.py status                          batches made, answered, crops labelled
#
# Invariants:
# - What leaves the node is the request body only: the Clef evaluation's state text (measured facts in plain words) and
#   the JPEG crop as a data URL, under a random token (secrets.token_hex). No crop id, view id, host hash, URL or file
#   path leaves the node; the key file never leaves it.
# - A batch made twice reuses its tokens, so answers that already came back stay valid.

import argparse
import glob
import gzip
import json
import os
import random
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT, V1  # noqa: E402
import luna_prompt  # noqa: E402

OA = os.path.join(OUT, "oa")


def nat_items():
    with open(os.path.join(V1, "index", "nat.jsonl")) as fh:
        return [json.loads(l) for l in fh]


def cmd_plan(a):
    path = os.path.join(OA, "plan.json")
    if os.path.exists(path) and not a.force:
        sys.exit("plan exists: %s (use --force to redo it before any batch is made)" % path)
    items = {it["id"]: it for it in nat_items()}
    ids = sorted(items)
    random.Random(a.seed).shuffle(ids)
    batches = [ids[s: s + a.size] for s in range(0, len(ids), a.size)]
    os.makedirs(os.path.join(OA, "items"), exist_ok=True)
    for k, b in enumerate(batches):  # node-only copies of the batch's index rows, so `make` reads one small file
        with open(os.path.join(OA, "items", "items-%d.jsonl" % k), "w") as out:
            for cid in b:
                out.write(json.dumps(items[cid]) + "\n")
    json.dump({"size": a.size, "seed": a.seed, "crops": len(ids), "batches": batches}, open(path, "w"))
    print(json.dumps({"crops": len(ids), "batches": len(batches)}))


def cmd_make(a):
    plan = json.load(open(os.path.join(OA, "plan.json")))
    ids = plan["batches"][a.batch]
    kd = os.path.join(OA, "keys")
    os.makedirs(kd, exist_ok=True)
    kp = os.path.join(kd, "key-%d.json" % a.batch)
    if os.path.exists(kp):
        key = json.load(open(kp))
        tok = {cid: t for t, cid in key.items()}
    else:
        tok = {cid: secrets.token_hex(8) for cid in ids}
        key = {t: cid for cid, t in tok.items()}
        tmp = kp + ".tmp"
        json.dump(key, open(tmp, "w"))
        os.replace(tmp, kp)
    with open(os.path.join(OA, "items", "items-%d.jsonl" % a.batch)) as fh:
        items = {it["id"]: it for it in (json.loads(l) for l in fh)}
    skip = set()
    if a.skip_answered:
        for f in glob.glob(os.path.join(OA, "answers", "answers-%d*.jsonl" % a.batch)):
            for line in open(f):
                try:
                    skip.add(json.loads(line)["t"])
                except (ValueError, KeyError):
                    pass
    out = gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb", compresslevel=3)
    n = 0
    for cid in ids:
        t = tok[cid]
        if t in skip:
            continue
        body = luna_prompt.build_request(items[cid])
        out.write((json.dumps({"t": t, "body": body}) + "\n").encode())
        n += 1
    out.close()
    sys.stdout.buffer.flush()
    print("batch %d: %d requests" % (a.batch, n), file=sys.stderr)


def read_answers():
    """token -> answer record, over every answers file (later lines win)."""
    got = {}
    for f in sorted(glob.glob(os.path.join(OA, "answers", "answers-*.jsonl"))):
        for line in open(f):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            got[r["t"]] = r
    return got


def cmd_collect(a):
    got = read_answers()
    n, miss = 0, 0
    tmp = os.path.join(OA, luna_prompt.VARIANT + ".jsonl.tmp")
    with open(tmp, "w") as out:
        for kp in sorted(glob.glob(os.path.join(OA, "keys", "key-*.json"))):
            for t, cid in json.load(open(kp)).items():
                r = got.get(t)
                if not r:
                    miss += 1
                    continue
                ans = r["answers"]
                out.write(json.dumps({"id": cid, "verdict": ans["verdict"]["probabilities"], "family": ans["family"]["probabilities"],
                                      "inputTokens": r.get("input_tokens")}) + "\n")
                n += 1
    os.replace(tmp, os.path.join(OA, luna_prompt.VARIANT + ".jsonl"))
    print(json.dumps({"labelled": n, "madeButUnanswered": miss}))


def cmd_status(a):
    plan = json.load(open(os.path.join(OA, "plan.json")))
    keys = glob.glob(os.path.join(OA, "keys", "key-*.json"))
    got = read_answers()
    print(json.dumps({"batches": len(plan["batches"]), "made": len(keys), "answered": len(got), "crops": plan["crops"]}))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("plan")
    p.add_argument("--size", type=int, default=2000)
    p.add_argument("--seed", type=int, default=3)
    p.add_argument("--force", action="store_true")
    p = sp.add_parser("make")
    p.add_argument("--batch", type=int, required=True)
    p.add_argument("--skip-answered", action="store_true", help="leave out crops whose answer already came back")
    sp.add_parser("collect")
    sp.add_parser("status")
    a = ap.parse_args()
    {"plan": cmd_plan, "make": cmd_make, "collect": cmd_collect, "status": cmd_status}[a.cmd](a)


if __name__ == "__main__":
    main()
