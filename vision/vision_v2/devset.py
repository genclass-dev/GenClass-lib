#!/usr/bin/env python3
# The fresh dev set of Vision v2, built the blind way Vision v1 built its frozen test set (vision/vision_v1/freshtest.py,
# whose design, sheets and resolution rule are copied here), on other hosts. Thresholds and the model choice of Vision
# v2 are made on it; the frozen test set is not touched until the one final evaluation.
#
#   devset.py hosts [--share 0.082]    choose the dev hosts: OUT/dev/devhosts.json (salted host hashes, node only)
#   devset.py build                    sample the dev crops, write the manifest and the blind sheets of passes A and B
#   devset.py chunks --pass A --chunks 3   JPEG sheets and a CSV template per labeller agent: OUT/dev/pass-A/out/A<k>/
#   devset.py adjudicate               sheets of pass C: crops where A and B disagree, nothing about their labels on them
#   devset.py resolve                  labels of the passes -> OUT/dev/labels.json (the test set's resolution rule)
#   devset.py digest | labeldigest     SHA-256 of the manifest / of the resolved labels
#
# Design:
# - Hosts: round-2 train hosts that are not near-duplicates and have no labelled crop of any kind (labels.json,
#   labels-extra.json, the round-2 hand checks), minus the 815 hosts Vision v1 held out for its test set (the 507 test
#   hosts and the rest of that pool). A share of them by a salted hash (salt `vision-v2-fresh-dev`) are the dev hosts.
#   Vision v2 trains on no element of these hosts. Vision v1 did train on them (with Clef's labels), so Vision v1's
#   numbers on this set are not fair to compare.
# - Pool and strata as in the test: the crawl's full-resolution candidate crops of the dev hosts; rules, random,
#   clef-high, clef-low, drawn in this order without replacement, in the test's proportions (500 : 350 : 350 : 100,
#   scaled to 600). Clef's teacher score chooses the last two strata, as in the test, so the dev set looks like the test.
# - Ids: dev ids and sheet codes are random (secrets.token_hex). The manifest, keys and labels stay on the node.
# - Labellers (separate AI-agent sessions) see only their own sheets and LABELLING.md: no model score, no Clef or
#   OpenAI output, no rule flag, no stratum, no other pass's labels.

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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import B, OUT, V1, host_hash  # noqa: E402

DD = os.path.join(OUT, "dev")
DEV_SALT = "vision-v2-fresh-dev"
QUOTA = {"rules": 230, "random": 162, "clef-high": 162, "clef-low": 46}  # the test's 500 : 350 : 350 : 100, scaled to 600
COLS, ROWS, WIDTH, CAPTION, PAD = 3, 3, 1500, 28, 6
FRAME = (230, 0, 160)


def labelled_hosts():
    """freshtest.py labelled_hosts(): every host with a labelled crop or a hand-checked flag."""
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


def in_dev(host, share):
    h = int(hashlib.sha256((DEV_SALT + ":" + host).encode()).hexdigest()[:8], 16)
    return h / 2**32 < share


def test_heldout_groups():
    return set(json.load(open(os.path.join(V1, "test", "heldout.json")))["g"])


def dev_groups():
    return set(json.load(open(os.path.join(DD, "devhosts.json")))["g"])


def cmd_hosts(a):
    if os.path.exists(os.path.join(DD, "manifest.jsonl")):
        sys.exit("the dev manifest exists; the dev hosts are fixed")
    lab = labelled_hosts()
    held = test_heldout_groups()
    hosts = set()
    with gzip.open(os.path.join(B, "trainset/views.jsonl.gz"), "rt") as fh:
        for line in fh:
            v = json.loads(line)
            if v["round"] == 0 and v["split"] == "train" and not v.get("dup"):
                hosts.add(v["host"])
    fresh = sorted(h for h in hosts if h not in lab and host_hash(h) not in held)
    dev = [h for h in fresh if in_dev(h, a.share)]
    g = sorted(host_hash(h) for h in dev)
    os.makedirs(DD, exist_ok=True)
    json.dump({"salt": DEV_SALT, "share": a.share, "trainHosts": len(hosts), "withLabels": len(hosts & lab),
               "testHeldOut": len(held), "fresh": len(fresh), "dev": len(dev), "g": g}, open(os.path.join(DD, "devhosts.json"), "w"))
    gs = set(g)
    pool = collections.Counter()
    for line in open(os.path.join(V1, "index", "nat.jsonl")):
        it = json.loads(line)
        if it["g"] in gs:
            pool[it["kind"]] += 1
            if it["kind"] == "cand":
                for s in it.get("sources") or []:
                    pool["cand-" + s] += 1
    print(json.dumps({"trainHosts": len(hosts), "withLabels": len(hosts & lab), "fresh": len(fresh), "dev": len(dev),
                      "devCrops": dict(pool)}))


def teacher_scores():
    """freshtest.py teacher_scores(): the sum of the logits of Clef's anyProblem under its two prompts."""
    from clef_answers import answered
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
    if os.path.exists(os.path.join(DD, "manifest.jsonl")):
        sys.exit("the dev manifest exists")
    groups = dev_groups()
    pool = [json.loads(l) for l in open(os.path.join(V1, "index", "nat.jsonl"))]
    pool = [it for it in pool if it["kind"] == "cand" and it["g"] in groups]
    ts = teacher_scores()
    missing = [it["id"] for it in pool if it["id"] not in ts]
    if missing:
        sys.exit("teacher scores missing for %d pool crops" % len(missing))
    rng = random.Random(a.seed)
    pool.sort(key=lambda it: it["id"])
    rng.shuffle(pool)
    N = len(pool)
    rules = [it for it in pool if "rules" in (it.get("sources") or [])]
    rest = [it for it in pool if "rules" not in (it.get("sources") or [])]
    chosen = []
    n_r = min(QUOTA["rules"], len(rules))
    for it in rules[:n_r]:
        chosen.append((it, "rules"))
    rand_src = [it for it in rest if "random" in (it.get("sources") or [])]
    n_rand = min(QUOTA["random"], len(rand_src))
    p_rand = n_rand / max(1, len(rand_src))
    taken = set()
    for it in rand_src[:n_rand]:
        chosen.append((it, "random"))
        taken.add(it["id"])
    left = [it for it in rest if it["id"] not in taken]
    left.sort(key=lambda it: -ts[it["id"]])
    n_hi = min(QUOTA["clef-high"], len(left))
    s_hi = ts[left[n_hi - 1]["id"]] if n_hi else float("inf")
    for it in left[:n_hi]:
        chosen.append((it, "clef-high"))
    lower = left[len(left) // 2:]
    lower = [it for it in lower if ts[it["id"]] < s_hi]
    rng.shuffle(lower)
    n_lo = min(QUOTA["clef-low"], len(lower))
    p_lo = n_lo / max(1, len(lower))
    s_med = ts[left[len(left) // 2]["id"]] if left else -float("inf")
    for it in lower[:n_lo]:
        chosen.append((it, "clef-low"))

    def incl(it, stratum):
        if stratum == "rules":
            return n_r / len(rules)
        p = p_rand if "random" in (it.get("sources") or []) else 0.0
        s = ts[it["id"]]
        q = 1.0 if s >= s_hi else (p_lo if s <= s_med else 0.0)
        return p + (1 - p) * q

    manifest = []
    for it, stratum in chosen:
        img = open(it["img"], "rb").read()
        manifest.append({"dev": secrets.token_hex(6), "crop": it["id"], "stratum": stratum, "pi": round(incl(it, stratum), 6),
                         "device": it["device"], "scheme": it["scheme"], "group": it["group"], "g": it["g"],
                         "rules": it.get("rules") or [], "img": it["img"], "inCrop": it["crop"]["inCrop"],
                         "imgSha256": hashlib.sha256(img).hexdigest()})
    manifest.sort(key=lambda m: m["dev"])
    os.makedirs(DD, exist_ok=True)
    with open(os.path.join(DD, "manifest.jsonl"), "w") as out:
        for m in manifest:
            out.write(json.dumps(m) + "\n")
    summ = {"built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "devHosts": len(groups),
            "hostsInPool": len({it["g"] for it in pool}), "pool": N, "poolRules": len(rules), "poolRandomSource": len(rand_src),
            "poolRest": len(left), "strata": dict(collections.Counter(m["stratum"] for m in manifest)),
            "hostsInDev": len({m["g"] for m in manifest}), "byDevice": dict(collections.Counter(m["device"] for m in manifest)),
            "byScheme": dict(collections.Counter(m["scheme"] for m in manifest)),
            "byGroup": dict(collections.Counter(m["group"] for m in manifest)), "quota": QUOTA, "seed": a.seed}
    json.dump(summ, open(os.path.join(DD, "summary.json"), "w"), indent=1)
    for p in ("A", "B"):
        sheets(manifest, p, random.Random(secrets.randbits(64)))
    print(json.dumps(summ))


def sheets(manifest, name, rng, ids=None):
    """freshtest.py sheets(): blind sheets of one labeller pass, its own order and its own random cell codes. The
    code -> dev id key stays in OUT/dev/pass-<name>/key.json on the node."""
    from PIL import Image, ImageDraw, ImageFont
    d = os.path.join(DD, "pass-" + name)
    os.makedirs(d, exist_ok=True)
    ms = [m for m in manifest if ids is None or m["dev"] in ids]
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
            key[code] = m["dev"]
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


def cmd_chunks(a):
    """label_chunks.py: one folder per labeller agent with JPEG copies of its sheets and a CSV template."""
    from PIL import Image
    d = os.path.join(DD, "pass-" + a.p)
    rows = list(csv.DictReader(open(os.path.join(d, "labels.csv"))))
    sheets_ = sorted({r["sheet"] for r in rows})
    per = (len(sheets_) + a.chunks - 1) // a.chunks
    for k in range(a.chunks):
        mine = sheets_[k * per: (k + 1) * per]
        if not mine:
            continue
        od = os.path.join(d, "out", "%s%d" % (a.p, k))
        os.makedirs(od, exist_ok=True)
        for s in mine:
            Image.open(os.path.join(d, s)).convert("RGB").save(os.path.join(od, s.replace(".png", ".jpg")), "JPEG", quality=90)
        with open(os.path.join(od, "labels-%s%d.csv" % (a.p, k)), "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["sheet", "cell", "code", "verdict", "family", "note"])
            for r in rows:
                if r["sheet"] in set(mine):
                    w.writerow([r["sheet"].replace(".png", ".jpg"), r["cell"], r["code"], "", "", ""])
        print("chunk %s%d: %d sheets" % (a.p, k, len(mine)))


def digest():
    h = hashlib.sha256()
    for line in sorted(open(os.path.join(DD, "manifest.jsonl"))):
        m = json.loads(line)
        h.update(("%s %s %s %.6f\n" % (m["dev"], m["imgSha256"], m["stratum"], m["pi"])).encode())
    return h.hexdigest()


FAMS = {"none", "text", "dark", "overflow", "responsive", "occlusion", "media", "leaks", "blank", "controls", "other"}


def read_pass(name):
    d = os.path.join(DD, "pass-" + name)
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
    manifest = [json.loads(l) for l in open(os.path.join(DD, "manifest.jsonl"))]
    dis = {m["dev"] for m in manifest if m["dev"] in A and m["dev"] in Bp and A[m["dev"]] != Bp[m["dev"]]}
    sheets(manifest, "C", random.Random(secrets.randbits(64)), ids=dis)
    print(json.dumps({"labelledA": len(A), "labelledB": len(Bp), "disagree": len(dis)}))


def cmd_resolve(a):
    """The test set's frozen rule: the verdict of A and B when they agree; otherwise the majority of A, B and C
    (unclear when all three differ or C is missing). Family of a real crop = the family at least two real votes share,
    else "mixed" (real for any-family counts, never in-family)."""
    A, Bp = read_pass("A"), read_pass("B")
    C = read_pass("C") if os.path.isdir(os.path.join(DD, "pass-C")) else {}
    manifest = [json.loads(l) for l in open(os.path.join(DD, "manifest.jsonl"))]
    out, n = {}, collections.Counter()
    for m in manifest:
        t = m["dev"]
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
    strata = {m["dev"]: m["stratum"] for m in manifest}
    stats = {"crops": len(manifest), "labelledByAandB": len(both), "verdictAgreementAB": round(po, 4),
             "kappaAB": round((po - pe) / (1 - pe), 4) if pe < 1 else None,
             "familyAgreementWhenBothReal": round(sum(1 for t in both if A[t][0] == Bp[t][0] == "real" and A[t][1] == Bp[t][1]) /
                                                  max(1, sum(1 for t in both if A[t][0] == Bp[t][0] == "real")), 4),
             "adjudicated": sum(1 for t in both if A[t] != Bp[t]), "passC": len(C), "resolved": dict(n),
             "realByFamily": dict(collections.Counter(x["family"] for x in out.values() if x["verdict"] == "real")),
             "realByStratum": dict(collections.Counter(strata[t] for t, x in out.items() if x["verdict"] == "real"))}
    json.dump({"stats": stats, "labels": out}, open(os.path.join(DD, "labels.json"), "w"), indent=1)
    print(json.dumps(stats))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("hosts")
    p.add_argument("--share", type=float, default=0.082)
    p = sp.add_parser("build")
    p.add_argument("--seed", type=int, default=23)
    p = sp.add_parser("chunks")
    p.add_argument("--pass", dest="p", required=True)
    p.add_argument("--chunks", type=int, default=3)
    for name in ("digest", "labeldigest", "adjudicate", "resolve"):
        sp.add_parser(name)
    a = ap.parse_args()
    if a.cmd == "digest":
        print(digest())
    elif a.cmd == "labeldigest":
        L = json.load(open(os.path.join(DD, "labels.json")))["labels"]
        h = hashlib.sha256()
        for t in sorted(L):
            h.update(("%s %s %s\n" % (t, L[t]["verdict"], L[t]["family"])).encode())
        print(h.hexdigest())
    else:
        {"hosts": cmd_hosts, "build": cmd_build, "chunks": cmd_chunks, "adjudicate": cmd_adjudicate,
         "resolve": cmd_resolve}[a.cmd](a)


if __name__ == "__main__":
    main()
