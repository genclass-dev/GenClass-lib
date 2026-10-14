#!/usr/bin/env python3
# The fresh test set of Vision v1: held-out hosts, a stratified sample of their crawl candidate crops, blind sheets
# for two (or more) independent labeller passes, the frozen manifest and its digest, and the label resolution.
#
#   freshtest.py hosts                 choose the held-out hosts (before any training): OUT/test/heldout.json
#   freshtest.py build                 sample the test crops, write the manifest and the blind sheets of passes A and B
#   freshtest.py digest                SHA-256 of the frozen manifest (what TEST-FROZEN.md records)
#   freshtest.py adjudicate            sheets of pass C: crops where A and B disagree, nothing about their labels on them
#   freshtest.py resolve               labels of the passes -> OUT/test/labels.json (the frozen resolution rule)
#
# Design (fixed in vision/results/vision-v1/TEST-FROZEN.md before any model is trained):
# - Hosts: round-2 train hosts that are not near-duplicates, have natural views and have no labelled crop of any kind
#   (labels.json, labels-extra.json, the round-2 hand checks). 15% of them by a salted hash are held out; Vision v1
#   never trains on any element of these hosts.
# - Pool: the crawl's full-resolution candidate crops of the held-out hosts' natural views (crawl.mjs: up to 2 v1
#   rule flags, 2 v1-model picks and 2 random visible elements per view). Viewport shots only exist for the first
#   screen, so every crop is an on-screen element.
# - Strata, drawn in this order without replacement: rules (rule-flagged crops), random (uniform over the crawl's
#   random visible elements), clef-high (the highest teacher scores among the rest), clef-low (uniform over the lower
#   half of teacher scores among the rest). The teacher score is the sum of the logits of Clef's anyProblem under
#   the two prompts (clef-img-p3, clef-imgonly-p2). Each crop records its inclusion probability for weighted metrics.
# - Ids: test ids and sheet codes are random (secrets.token_hex); nothing derives from host, view or URL.
# - Labellers see only the sheets and LABELLING.md: no Clef output, no model score, no other pass's labels.

import argparse
import collections
import csv
import glob
import gzip
import hashlib
import json
import math
import os
import random
import secrets
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import B, OUT, host_hash  # noqa: E402

TD = os.path.join(OUT, "test")
HOLD_SALT = "vision-v1-fresh-test"
HOLD_SHARE = 0.15
QUOTA = {"rules": 500, "random": 350, "clef-high": 350, "clef-low": 100}
COLS, ROWS, WIDTH, CAPTION, PAD = 3, 3, 1500, 28, 6
FRAME = (230, 0, 160)


def labelled_hosts():
    hosts = set()
    for f in ("labels.json", "labels-extra.json"):
        L = json.load(open(os.path.join(B, f)))
        for x in (L["labels"] if isinstance(L, dict) else L):
            hosts.add(x["host"])
    for f in glob.glob(os.path.join(B, "handcheck", "*", "*.json")) + glob.glob(os.path.join(B, "results", "handcheck-*.json")):
        try:
            d = json.load(open(f))
        except ValueError:
            continue
        stack = [d]
        while stack:
            x = stack.pop()
            if isinstance(x, dict):
                for k, v in x.items():
                    if k == "host" and isinstance(v, str):
                        hosts.add(v)
                    else:
                        stack.append(v)
            elif isinstance(x, list):
                stack.extend(x)
    return hosts


def held_out(host):
    h = int(hashlib.sha256((HOLD_SALT + ":" + host).encode()).hexdigest()[:8], 16)
    return h / 2**32 < HOLD_SHARE


def cmd_hosts(a):
    lab = labelled_hosts()
    hosts = set()
    with gzip.open(os.path.join(B, "trainset/views.jsonl.gz"), "rt") as fh:
        for line in fh:
            v = json.loads(line)
            if v["round"] == 0 and v["split"] == "train" and not v.get("dup"):
                hosts.add(v["host"])
    fresh = sorted(h for h in hosts if h not in lab)
    hold = [h for h in fresh if held_out(h)]
    os.makedirs(TD, exist_ok=True)
    # node-only: the salted v1 host hashes (as in the index files' `g`), never the hosts
    json.dump({"salt": HOLD_SALT, "share": HOLD_SHARE, "trainHosts": len(hosts), "trainHostsWithLabels": len(hosts & lab),
               "heldOut": len(hold), "g": sorted(host_hash(h) for h in hold)}, open(os.path.join(TD, "heldout.json"), "w"))
    print(json.dumps({"trainHosts": len(hosts), "withLabels": len(hosts & lab), "freshTrainHosts": len(fresh), "heldOut": len(hold)}))


def heldout_groups():
    return set(json.load(open(os.path.join(TD, "heldout.json")))["g"])


def teacher_scores():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from clef_label import answered
    A, Bv = answered("clef-img-p3"), answered("clef-imgonly-p2")

    def lg(r):
        p = 1.0 - r["answers"]["family"]["probabilities"].get("none", 0.0)
        p = min(max(p, 1e-6), 1 - 1e-6)
        return math.log(p / (1 - p))

    out = {}
    for cid in set(A) | set(Bv):
        xs = [lg(r[cid]) for r in (A, Bv) if cid in r]
        out[cid] = sum(xs) * 2 / len(xs)
    return out


def cmd_build(a):
    groups = heldout_groups()
    pool = [json.loads(l) for l in open(os.path.join(OUT, "index", "nat.jsonl"))]
    pool = [it for it in pool if it["kind"] == "cand" and it["g"] in groups]
    ts = teacher_scores()
    missing = [it["id"] for it in pool if it["id"] not in ts]
    if missing:
        sys.exit("teacher scores missing for %d pool crops: run clef_label.py first" % len(missing))
    rng = random.Random(a.seed)
    pool.sort(key=lambda it: it["id"])
    rng.shuffle(pool)
    N = len(pool)
    rules = [it for it in pool if "rules" in (it.get("sources") or [])]
    rest = [it for it in pool if "rules" not in (it.get("sources") or [])]
    chosen = []
    # rules: uniform (all of them when there are fewer than the quota)
    n_r = min(QUOTA["rules"], len(rules))
    for it in rules[:n_r]:
        chosen.append((it, "rules", n_r / len(rules)))
    # random: uniform over the crawl's random visible elements that no rule flagged
    rand_src = [it for it in rest if "random" in (it.get("sources") or [])]
    n_rand = min(QUOTA["random"], len(rand_src))
    p_rand = n_rand / max(1, len(rand_src))
    taken = set()
    for it in rand_src[:n_rand]:
        chosen.append((it, "random", None))
        taken.add(it["id"])
    left = [it for it in rest if it["id"] not in taken]
    left.sort(key=lambda it: -ts[it["id"]])
    n_hi = min(QUOTA["clef-high"], len(left))
    s_hi = ts[left[n_hi - 1]["id"]] if n_hi else float("inf")
    for it in left[:n_hi]:
        chosen.append((it, "clef-high", None))
    lower = left[len(left) // 2:]
    lower = [it for it in lower if ts[it["id"]] < s_hi]
    rng.shuffle(lower)
    n_lo = min(QUOTA["clef-low"], len(lower))
    p_lo = n_lo / max(1, len(lower))
    s_med = ts[left[len(left) // 2]["id"]] if left else -float("inf")
    for it in lower[:n_lo]:
        chosen.append((it, "clef-low", None))

    def incl(it, stratum):
        """Inclusion probability of a crop under this design (for Horvitz-Thompson weights over the pool)."""
        if stratum == "rules":
            return n_r / len(rules)
        p = p_rand if "random" in (it.get("sources") or []) else 0.0
        s = ts[it["id"]]
        q = 1.0 if s >= s_hi else (p_lo if s <= s_med else 0.0)
        return p + (1 - p) * q

    manifest = []
    for it, stratum, _ in chosen:
        img = open(it["img"], "rb").read()
        manifest.append({"test": secrets.token_hex(6), "crop": it["id"], "stratum": stratum, "pi": round(incl(it, stratum), 6),
                         "device": it["device"], "scheme": it["scheme"], "group": it["group"], "g": it["g"],
                         "rules": it.get("rules") or [], "img": it["img"], "inCrop": it["crop"]["inCrop"],
                         "imgSha256": hashlib.sha256(img).hexdigest()})
    manifest.sort(key=lambda m: m["test"])
    os.makedirs(TD, exist_ok=True)
    with open(os.path.join(TD, "manifest.jsonl"), "w") as out:
        for m in manifest:
            out.write(json.dumps(m) + "\n")
    summ = {"built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "heldOutHosts": len(groups),
            "hostsInPool": len({it["g"] for it in pool}), "pool": N, "poolRules": len(rules), "poolRandomSource": len(rand_src),
            "poolRest": len(left), "strata": dict(collections.Counter(m["stratum"] for m in manifest)),
            "hostsInTest": len({m["g"] for m in manifest}), "byDevice": dict(collections.Counter(m["device"] for m in manifest)),
            "byScheme": dict(collections.Counter(m["scheme"] for m in manifest)),
            "byGroup": dict(collections.Counter(m["group"] for m in manifest)), "quota": QUOTA, "seed": a.seed}
    json.dump(summ, open(os.path.join(TD, "summary.json"), "w"), indent=1)
    for p in ("A", "B"):
        sheets(manifest, p, random.Random(secrets.randbits(64)))
    print(json.dumps(summ))


def sheets(manifest, name, rng, ids=None):
    """Blind sheets of one labeller pass: its own order and its own random cell codes. The code -> test id key stays
    in OUT/test/pass-<name>/key.json on the node; the sheets show the cell, the code, the device and the colour scheme."""
    from PIL import Image, ImageDraw, ImageFont
    d = os.path.join(TD, "pass-" + name)
    os.makedirs(d, exist_ok=True)
    ms = [m for m in manifest if ids is None or m["test"] in ids]
    rng.shuffle(ms)
    try:
        font = ImageFont.load_default(size=16)
    except TypeError:
        font = ImageFont.load_default()
    per = COLS * ROWS
    cw = WIDTH // COLS
    ch = int(cw * 0.78) + CAPTION
    key, rows = {}, []
    for s in range(0, len(ms), per):
        sheet = Image.new("RGB", (cw * COLS, ch * ROWS), (236, 236, 236))
        dr = ImageDraw.Draw(sheet)
        file = "sheet-%s-%03d.png" % (name, s // per)
        for k, m in enumerate(ms[s: s + per]):
            code = secrets.token_hex(3)
            key[code] = m["test"]
            cell = k + 1
            cx, cy = (k % COLS) * cw, (k // COLS) * ch
            dr.rectangle([cx, cy, cx + cw - 1, cy + ch - 1], outline=(150, 150, 150))
            dr.text((cx + PAD, cy + 5), "%d  %s   %s, %s" % (cell, code, m["device"], m["scheme"]), fill=(0, 0, 0), font=font)
            im = Image.open(m["img"]).convert("RGB")
            aw, ah = cw - 2 * PAD, ch - CAPTION - PAD
            f = min(aw / max(1, im.width), ah / max(1, im.height), 3.0)
            im = im.resize((max(1, int(im.width * f)), max(1, int(im.height * f))))
            ox, oy = cx + PAD + (aw - im.width) // 2, cy + CAPTION + (ah - im.height) // 2
            sheet.paste(im, (ox, oy))
            # the frame sits just outside the element's box, clipped to the crop (a box larger than the crop
            # continues past its edges) so it never reaches into a neighbouring cell
            x, y, w, h = [float(v) * f for v in m["inCrop"]]
            fx0, fy0 = max(ox - 2, ox + x - 2), max(oy - 2, oy + y - 2)
            fx1, fy1 = min(ox + im.width + 1, ox + x + max(w, 0) + 1), min(oy + im.height + 1, oy + y + max(h, 0) + 1)
            if fx1 > fx0 and fy1 > fy0:
                dr.rectangle([fx0, fy0, fx1, fy1], outline=FRAME, width=2)
            rows.append([file, cell, code, "", "", ""])
        sheet.save(os.path.join(d, file))
    json.dump(key, open(os.path.join(d, "key.json"), "w"))
    with open(os.path.join(d, "labels.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["sheet", "cell", "code", "verdict", "family", "note"])
        w.writerows(rows)
    print("pass %s: %d crops on %d sheets in %s" % (name, len(ms), (len(ms) + per - 1) // per, d))


def digest():
    """SHA-256 over the manifest's test ids, crop image digests and strata, sorted by test id."""
    h = hashlib.sha256()
    for line in sorted(open(os.path.join(TD, "manifest.jsonl"))):
        m = json.loads(line)
        h.update(("%s %s %s %.6f\n" % (m["test"], m["imgSha256"], m["stratum"], m["pi"])).encode())
    return h.hexdigest()


FAMS = {"none", "text", "dark", "overflow", "responsive", "occlusion", "media", "leaks", "blank", "controls", "other"}


def read_pass(name):
    d = os.path.join(TD, "pass-" + name)
    key = json.load(open(os.path.join(d, "key.json")))
    out = {}
    for f in sorted(glob.glob(os.path.join(d, "labels-*.csv"))):
        with open(f) as fh:
            for r in csv.DictReader(fh):
                code = (r.get("code") or "").strip().lower()
                if code not in key:
                    continue
                v = (r.get("verdict") or "").strip().lower()
                fam = (r.get("family") or "").strip().lower()
                if v not in ("real", "not", "unclear"):
                    continue
                if v != "real":
                    fam = "none"
                elif fam not in FAMS or fam == "none":
                    fam = "other"
                out[key[code]] = (v, fam)
    return out


def cmd_adjudicate(a):
    A, Bp = read_pass("A"), read_pass("B")
    manifest = [json.loads(l) for l in open(os.path.join(TD, "manifest.jsonl"))]
    dis = {m["test"] for m in manifest if m["test"] in A and m["test"] in Bp and A[m["test"]] != Bp[m["test"]]}
    sheets(manifest, "C", random.Random(secrets.randbits(64)), ids=dis)
    print(json.dumps({"labelledA": len(A), "labelledB": len(Bp), "disagree": len(dis)}))


def cmd_resolve(a):
    """Frozen rule: verdict = the verdict of A and B when they agree; otherwise the majority of A, B and C (unclear
    when all three differ or C is missing). Family of a real crop = the family at least two real votes share, else
    "mixed" (real for any-family counts, never in-family)."""
    A, Bp = read_pass("A"), read_pass("B")
    C = read_pass("C") if os.path.isdir(os.path.join(TD, "pass-C")) else {}
    manifest = [json.loads(l) for l in open(os.path.join(TD, "manifest.jsonl"))]
    out, n = {}, collections.Counter()
    for m in manifest:
        t = m["test"]
        votes = [p[t] for p in (A, Bp, C) if t in p]
        if t not in A or t not in Bp:
            n["missingAB"] += 1
        if len(votes) >= 2 and votes[0] == votes[1]:
            v, fam = votes[0]
        else:
            vs = collections.Counter(x[0] for x in votes)
            top, k = vs.most_common(1)[0] if vs else ("unclear", 0)
            v = top if k >= 2 else "unclear"
            fam = "none"
            if v == "real":
                fs = collections.Counter(x[1] for x in votes if x[0] == "real")
                f, kf = fs.most_common(1)[0]
                fam = f if kf >= 2 else "mixed"
        out[t] = {"verdict": v, "family": fam, "votes": len(votes)}
        n[v] += 1
    both = [t for t in A if t in Bp]
    agree = sum(1 for t in both if A[t][0] == Bp[t][0])
    cats = ["real", "unclear", "not"]
    po = agree / max(1, len(both))
    pa = collections.Counter(A[t][0] for t in both)
    pb = collections.Counter(Bp[t][0] for t in both)
    pe = sum(pa[c] * pb[c] for c in cats) / max(1, len(both)) ** 2
    stats = {"crops": len(manifest), "labelledByAandB": len(both), "verdictAgreementAB": round(po, 4),
             "kappaAB": round((po - pe) / (1 - pe), 4) if pe < 1 else None,
             "familyAgreementWhenBothReal": round(sum(1 for t in both if A[t][0] == Bp[t][0] == "real" and A[t][1] == Bp[t][1]) /
                                                  max(1, sum(1 for t in both if A[t][0] == Bp[t][0] == "real")), 4),
             "adjudicated": sum(1 for t in both if A[t] != Bp[t]), "passC": len(C), "resolved": dict(n),
             "realByFamily": dict(collections.Counter(x["family"] for x in out.values() if x["verdict"] == "real"))}
    json.dump({"stats": stats, "labels": out}, open(os.path.join(TD, "labels.json"), "w"), indent=1)
    print(json.dumps(stats))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("hosts")
    p = sp.add_parser("build")
    p.add_argument("--seed", type=int, default=11)
    p = sp.add_parser("sheets")  # (re)draw the blind sheets of passes A and B from the frozen manifest
    p.add_argument("--passes", default="A,B")
    sp.add_parser("digest")
    sp.add_parser("adjudicate")
    sp.add_parser("resolve")
    sp.add_parser("labeldigest")
    a = ap.parse_args()
    if a.cmd == "digest":
        print(digest())
    elif a.cmd == "labeldigest":
        # SHA-256 over the resolved labels, "test-id verdict family" lines sorted by test id
        L = json.load(open(os.path.join(TD, "labels.json")))["labels"]
        h = hashlib.sha256()
        for t in sorted(L):
            h.update(("%s %s %s\n" % (t, L[t]["verdict"], L[t]["family"])).encode())
        print(h.hexdigest())
    elif a.cmd == "sheets":
        manifest = [json.loads(l) for l in open(os.path.join(TD, "manifest.jsonl"))]
        for p in a.passes.split(","):
            sheets(manifest, p, random.Random(secrets.randbits(64)))
    else:
        {"hosts": cmd_hosts, "build": cmd_build, "adjudicate": cmd_adjudicate, "resolve": cmd_resolve}[a.cmd](a)


if __name__ == "__main__":
    main()
