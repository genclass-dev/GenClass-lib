# Classifies each reordered run of an explore report into what the user would see.
#   form:    the item form shows another item's values (title/summary/status/topic) under the URL
#   header:  the header title (display template) shows another item
#   display: an M2O display (author, related) shows another item while the form is right
#   counts:  only request counts differ (and maybe witnesses): not a stale view
#   witness: nothing in the final state differs; only a witness the baselines did not have (GenClass's "ended right")
# usage: python3 -I classify.py results/<tag>/*.json
import json
import re
import sys

FORM = ("directus.form.title", "directus.form.summary", "directus.form.status", "directus.form.topic")
DISPLAY = ("directus.form.related", "directus.form.author")

rows = []
for path in sys.argv[1:]:
    s = json.load(open(path))
    rep = s.get("report", "")
    runs = re.split(r"\n- run (r\d+) \(seed (\d+)\)[^\n]*:\n", rep)
    classes = {"form": 0, "header": 0, "display": 0, "counts": 0, "witness": 0, "same": 0}
    planned = s.get("runs", 6)
    failed = sum(1 for r in s.get("results", []) if "failed" in r)
    blocks = []
    for i in range(1, len(runs) - 2, 3):
        blocks.append(runs[i + 2].split("\nRace finding")[0])
    for b in blocks:
        if any(f'state "{k}"' in b for k in FORM):
            classes["form"] += 1
        elif 'state "directus.form.header"' in b:
            classes["header"] += 1
        elif any(f'state "{k}"' in b for k in DISPLAY):
            classes["display"] += 1
        elif "requests sent to" in b:
            classes["counts"] += 1
        else:
            classes["witness"] += 1
    m = re.search(r"RACE: (\d+) of (\d+)", rep)
    seeded = int(m.group(2)) if m else None
    if m is None:
        m2 = re.search(r"all (\d+) reordered run", rep)
        seeded = int(m2.group(1)) if m2 else None
    if seeded is not None:
        classes["same"] = seeded - len(blocks)
    header_any = sum(1 for b in blocks if 'state "directus.form.header"' in b)
    display_any = sum(1 for b in blocks if any(f'state "{k}"' in b for k in DISPLAY))
    rows.append({
        "file": path.split("/")[-1],
        "gap": s.get("gapMs"), "slow": s.get("slowMs"),
        "verdict": s.get("verdict"), "seeded": seeded, "failedLoads": failed,
        **classes, "headerAny": header_any, "displayAny": display_any,
        "baselineFinals": [r.get("title") for r in s.get("results", [])[:2]],
    })
for r in rows:
    print(json.dumps(r))
