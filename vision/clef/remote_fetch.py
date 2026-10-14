# Runs on the crawl node (the v2 data under ~/vision-out/v2) and writes only to stdout, so the node is left as it was:
#   ssh azureuser@"${IP}" 'nice -n 19 python3 - crops' < remote_fetch.py > fetch1.tar   # then: tar -xf fetch1.tar -C DATA/raw
#   ssh azureuser@"${IP}" 'nice -n 19 python3 - facts' < remote_fetch.py > DATA/facts.jsonl
# "crops": a tar of the labelled crops, their sidecars and the label and sheet files.
# "facts": one JSON line per labelled crop with the raw element row (vision/src/extract.js), up to four ancestor rows,
# the direct children, the page-level record of its view and its trainset feature row.
# The files it reads name crawled hosts; eval.py keeps them out of everything it writes.
import glob, gzip, json, os, struct, sys, tarfile

B = os.path.expanduser("~/vision-out/v2")
L = json.load(open(f"{B}/labels.json"))["labels"]
mode = sys.argv[1] if len(sys.argv) > 1 else "crops"

if mode == "crops":
    ids = sorted({x["id"] for x in L})
    shards = sorted(d for d in os.listdir(f"{B}/crawl") if d.startswith("shard-") and os.path.isdir(f"{B}/crawl/{d}"))
    tf = tarfile.open(fileobj=sys.stdout.buffer, mode="w|")
    for f in ["labels.json", "labels-raw.json", "sheets/index.json", "sheets/selection.json", "sheets/labels.csv",
              "results/labels.json", "models/v2/search.json", "trainset/schema.json", "trainset/summary.json",
              "counts.json", "counts-set.json", "counts-crawl.json"]:
        if os.path.exists(f"{B}/{f}"):
            tf.add(f"{B}/{f}", arcname=f, recursive=False)
    miss = []
    for cid in ids:
        for s in shards:
            p = f"{B}/crawl/{s}/crops/{cid}"
            if os.path.exists(p + ".jpg"):
                tf.add(p + ".jpg", arcname=f"crops/{cid}.jpg", recursive=False)
                if os.path.exists(p + ".json"):
                    tf.add(p + ".json", arcname=f"crops/{cid}.json", recursive=False)
                break
        else:
            miss.append(cid)
    sys.stderr.write(f"ids={len(ids)} missing={len(miss)}\n")
    tf.close()
    sys.exit(0)

want = {}
for x in L:
    want.setdefault(x["vid"], set()).add(x["i"])
recs, views = {}, {}
for shard in sorted(glob.glob(f"{B}/crawl/shard-*/")):
    for kind, store in (("views", views), ("elements", None)):
        for f in sorted(glob.glob(shard + kind + "-*.jsonl.gz")):
            with gzip.open(f, "rt") as fh:
                for line in fh:
                    vid = line[8: line.find('"', 8)]  # every line starts with {"vid":"
                    if vid not in want:
                        continue
                    r = json.loads(line)
                    if store is not None:
                        store[vid] = r
                    else:
                        recs.setdefault(vid, {})[r["i"]] = r
    sys.stderr.write(f"{shard} views={len(views)}\n")
F = json.load(open(f"{B}/trainset/schema.json"))["F"]
xf = {s: open(f"{B}/trainset/X-{s}.f32", "rb") for s in ("val", "test")}
seen = set()
for x in L:
    if x["id"] in seen:
        continue
    seen.add(x["id"])
    vr = recs.get(x["vid"], {})
    el = vr.get(x["i"])
    anc, p = [], (el or {}).get("p", -1)
    while p is not None and p >= 0 and len(anc) < 4 and vr.get(p):
        anc.append(vr[p])
        p = vr[p].get("p", -1)
    kids = [r for r in vr.values() if r.get("p") == x["i"]][:12] if el else []
    row = None
    if x.get("split") in xf and isinstance(x.get("row"), int):
        fh = xf[x["split"]]
        fh.seek(x["row"] * F * 4)
        b = fh.read(F * 4)
        if len(b) == F * 4:
            row = list(struct.unpack(f"<{F}f", b))
    v = views.get(x["vid"])
    page = None
    if v:
        page = {k: v.get(k) for k in ("device", "scheme", "inj", "round", "group", "builder")}
        page["page"] = v.get("page")
    print(json.dumps({"id": x["id"], "vid": x["vid"], "i": x["i"], "el": el, "anc": anc, "kids": kids, "page": page, "row": row}))
sys.stderr.write(f"done {len(seen)}\n")
