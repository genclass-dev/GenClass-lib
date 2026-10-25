# Renders the hunt's result tables (markdown) from the raw result files, so the report's numbers are computed.
# usage: python3 -I make-tables.py <results dir>
import glob
import json
import os
import re
import sys
from collections import OrderedDict

R = sys.argv[1] if len(sys.argv) > 1 else "results"
FORM = ("directus.form.title", "directus.form.summary", "directus.form.status", "directus.form.topic")
DISPLAY = ("directus.form.related", "directus.form.author")


def blocks_of(rep):
    parts = re.split(r"\n- run (r\d+) \(seed (\d+)\)([^\n]*):\n", rep)
    out = []
    for i in range(1, len(parts) - 3, 4):
        out.append((int(parts[i + 1]), "ran out" in parts[i + 2], parts[i + 3].split("\nRace finding")[0]))
    return out


def cls(b):
    if any(f'state "{k}"' in b for k in FORM):
        return "form"
    if 'state "directus.form.header"' in b:
        return "header"
    if any(f'state "{k}"' in b for k in DISPLAY):
        return "display"
    if "requests sent to" in b:
        return "counts"
    return "witness"


def sessions(tag, scen):
    files = glob.glob(f"{R}/{tag}/{scen}-g*-s*.json")
    key = lambda p: (int(re.search(r"-s(\d+)\.json", p).group(1)), int(re.search(r"-g(\d+)-", p).group(1)))
    return [(p, json.load(open(p))) for p in sorted(files, key=key)]


def verdict(s):
    m = re.search(r"RACE: (\d+) of (\d+)[^\n;]*(?:; (\d+) more ended right)?", s["report"])
    if m:
        return f"{m.group(1)} of {m.group(2)}" + (f" (+{m.group(3)} ended right with a witness)" if m.group(3) else "")
    m = re.search(r"RACE: no reordered run ended differently, but (\d+) of (\d+)", s["report"])
    if m:
        return f"0 of {m.group(2)} (+{m.group(1)} with a witness)"
    m = re.search(r"all (\d+) reordered run", s["report"])
    return f"no race (0 of {m.group(1)})" if m else "?"


def nav_table(tag):
    rows = sessions(tag, "nav-back")
    tot = OrderedDict((k, 0) for k in ["seeded", "form", "header", "display", "counts", "witness", "same", "baseOk", "base"])
    print(f"| slow_ms | gap ms | GenClass verdict | stale form | stale header only | stale M2O display only | request counts only | witness only | same as baseline | baselines right |")
    print("|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|")
    for p, s in rows:
        bl = blocks_of(s["report"])
        c = OrderedDict((k, 0) for k in ["form", "header", "display", "counts", "witness"])
        for _, _, b in bl:
            c[cls(b)] += 1
        seeded = s["runs"]
        same = seeded - len(bl)
        base = s["results"][:2]
        base_ok = sum(1 for r in base if r.get("title") == "Alpha: launch checklist" and r.get("url", "").endswith("/articles/1"))
        print(f"| {s['slowMs']} | {s['gapMs']} | {verdict(s)} | {c['form']} | {c['header']} | {c['display']} | {c['counts']} | {c['witness']} | {same} | {base_ok} of 2 |")
        tot["seeded"] += seeded
        for k in c:
            tot[k] += c[k]
        tot["same"] += same
        tot["baseOk"] += base_ok
        tot["base"] += 2
    print(f"| **all** | | | **{tot['form']}** of {tot['seeded']} | {tot['header']} | {tot['display']} | {tot['counts']} | {tot['witness']} | {tot['same']} | {tot['baseOk']} of {tot['base']} |")
    print()
    return tot


def seed_table(tag):
    rows = sessions(tag, "nav-back")
    print("| session (slow_ms, gap) | seed 1 | seed 2 | seed 3 | seed 4 | seed 5 | seed 6 |")
    print("|---|---|---|---|---|---|---|")
    for p, s in rows:
        m = {seed: cls(b) + ("*" if forced else "") for seed, forced, b in blocks_of(s["report"])}
        print(f"| {s['slowMs']}, {s['gapMs']} | " + " | ".join(m.get(k, "same") for k in range(1, 7)) + " |")
    print()


def menu_table(tag):
    rows = sessions(tag, "autocomplete")
    if not rows:
        return
    print("| slow_ms | gap ms | GenClass verdict | seeded runs whose menu lists tags not starting with \"rea\" | seeded runs with no menu | baselines' menus |")
    print("|---:|---:|---|---:|---:|---|")
    tot = [0, 0, 0]
    for p, s in rows:
        res = s["results"]
        stale = sum(1 for r in res[2:] if any(not x.startswith("rea") for x in r.get("menu", [])))
        empty = sum(1 for r in res[2:] if not r.get("menu"))
        print(f"| {s['slowMs']} | {s['gapMs']} | {verdict(s)} | {stale} of {len(res) - 2} | {empty} of {len(res) - 2} | {', '.join(str(len(r.get('menu', []))) + ' items' for r in res[:2])} |")
        tot[0] += stale
        tot[1] += len(res) - 2
        tot[2] += empty
    print(f"| **all** | | | **{tot[0]} of {tot[1]}** | {tot[2]} of {tot[1]} | |")
    print()


def picker_table(tag):
    rows = sessions(tag, "picker")
    if not rows:
        return
    print("| slow_ms | gap ms | GenClass verdict | final Related display (all 8 loads) |")
    print("|---:|---:|---|---|")
    for p, s in rows:
        finals = sorted(set(r.get("related") for r in s["results"]))
        print(f"| {s['slowMs']} | {s['gapMs']} | {verdict(s)} | {', '.join(map(str, finals))} |")
    print()


def plain_table(tag):
    f = f"{R}/{tag}/plain.jsonl"
    if not os.path.exists(f):
        return
    rows = [json.loads(l) for l in open(f)]
    t = OrderedDict()
    for r in rows:
        t.setdefault((r["delayMs"], r["gapMs"]), []).append(r)
    print("| article 2 response delayed by (ms) | gap between the clicks (ms) | back click measured at (ms after the relation click) | stale form under /articles/1 |")
    print("|---:|---:|---|---:|")
    by_delay = OrderedDict()
    for (d, g), v in sorted(t.items()):
        print(f"| {d} | {g} | {', '.join(str(x['backClickAt']) for x in v)} | {sum(x['stale'] for x in v)} of {len(v)} |")
        a = by_delay.setdefault(d, [0, 0])
        a[0] += sum(x["stale"] for x in v)
        a[1] += len(v)
    print()
    print("By delay: " + "; ".join(f"{d} ms: {a[0]} of {a[1]}" for d, a in by_delay.items()))
    print()


def save_table(tag):
    for kind in ("summary", "title"):
        f = f"{R}/{tag}/save-{kind}.jsonl"
        if not os.path.exists(f):
            continue
        print(f"Save after editing the {kind} ({tag}):")
        print()
        print("| run | form stale before the edit | PATCH | body | article 1 in the database after | article 2 after |")
        print("|---:|---|---|---|---|---|")
        for l in open(f):
            r = json.loads(l)
            db1 = {k: r["db"]["1"][k] for k in ("title", "summary")}
            db2 = {k: r["db"]["2"][k] for k in ("title", "summary")}
            print(f"| {r['n']} | {'yes' if r['stale'] else 'no'} | `{r['patch']['path']}` | `{json.dumps(r['patch']['body'])}` | `{json.dumps(db1)}` | `{json.dumps(db2)}` |")
        print()


for tag in ("buggy", "fixed", "fixed-all", "fixed-ac2"):
    if not os.path.isdir(f"{R}/{tag}"):
        continue
    print(f"## {tag}")
    print()
    if sessions(tag, "nav-back"):
        nav_table(tag)
        seed_table(tag)
    picker_table(tag)
    menu_table(tag)
    plain_table(tag)
    save_table(tag)
