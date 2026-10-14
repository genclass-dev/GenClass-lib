#!/usr/bin/env python3
# Markdown tables from the evaluation JSONs (selection.json, dev.json, test-final.json), for RESULTS.md.
#
#   report.py --eval DIR [--final test-final.json]

import argparse
import json
import os

NAMES = {"v2": "Vision v2", "v1": "Vision v1", "clef": "Clef (both prompts)", "luna": "OpenAI (luna-img-p3)",
         "ens": "OpenAI + Clef averaged", "gbtSmallV1": "v1 gbt-small"}


def f3(v):
    return "–" if v is None else ("%.3f" % v)


def rank_row(name, r):
    if not r:
        return "| %s | – | – | – | – | – | – |" % name
    return "| %s | %d | %d | %s | %s | %s | %s |" % (name, r["n"], r["real"], f3(r["ap"]), f3(r["precisionAtRecall0.5"]),
                                                 f3(r["recallAtPrecision0.6"]), f3(r["recallAtPrecision0.8"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eval", required=True)
    ap.add_argument("--final", default="test-final.json")
    a = ap.parse_args()
    sel = json.load(open(os.path.join(a.eval, "selection.json")))
    print("## Selection (fresh dev)\n")
    print("| run | score | family target | any head | lr head / backbone | seed | dev AP (last 3) | dev AP final | round-2 dev AP | minutes |")
    print("|---|---|---|---|---|---:|---:|---:|---:|---:|")
    for r in sel["rows"]:
        print("| %s | %s | %s | %s | %g / %g | %d | %.3f | %.3f | %s | %s |" % (
            r["run"], r["score"], r["famTarget"], "yes" if r["anyHead"] else "no", r["lr"], r["lrBackbone"], r["seed"],
            r["devApLast3"], r["devApFinal"], f3(r["round2DevApFinal"]), round(r["trainSeconds"] / 60) if r["trainSeconds"] else "–"))
    dev = json.load(open(os.path.join(a.eval, "dev.json")))
    print("\n## Dev ranking (fresh dev, unclear left out)\n")
    print("| detector | crops | real | AP | P at R 0.5 | R at P 0.6 | R at P 0.8 |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for j in ("v2", "v1", "clef", "luna", "ens"):
        print(rank_row(NAMES[j], dev["ranking"].get(j)))
    print("\nDev thresholds:", json.dumps({k: round(v, 4) for k, v in dev["thresholds"].items() if v is not None and not k.startswith("rules:")}))
    p = os.path.join(a.eval, a.final)
    if not os.path.exists(p):
        return
    t = json.load(open(p))
    print("\n## Test ranking, any problem (unclear left out)\n")
    print("| detector | slice | crops | real | AP | P at R 0.5 | R at P 0.6 | R at P 0.8 |")
    print("|---|---|---:|---:|---:|---:|---:|---:|")
    for sl in ("all", "rules", "random", "clef-high", "clef-low"):
        for j in ("v2", "v1", "clef", "luna", "ens", "gbtSmallV1"):
            r = t["ranking"][j].get(sl)
            if r is None and sl != "all":
                continue
            row = rank_row(NAMES[j], r)
            print(row.replace("| %s |" % NAMES[j], "| %s | %s |" % (NAMES[j], sl), 1))
    print("\n## Paired AP differences, Vision v2 minus each (test, host bootstrap, 2,000 resamples)\n")
    print("| slice | vs Vision v1 | vs Clef | vs OpenAI | vs OpenAI + Clef |")
    print("|---|---|---|---|---|")
    for f, d in t["vs"].items():
        cells = ["%+.3f [%+.3f, %+.3f] %s" % (d[j]["diff"], d[j]["ci95"][0], d[j]["ci95"][1], d[j]["verdict"]) for j in ("v1", "clef", "luna", "ens")]
        print("| %s | %s |" % (f, " | ".join(cells)))
    print("\n## Per family (test, the family's reals against every not; own-family probability)\n")
    print("| family (real) | Vision v2 AP / P@R0.5 / R@P0.6 / R@P0.8 | Vision v1 | Clef | OpenAI | OpenAI + Clef |")
    print("|---|---|---|---|---|---|")
    for f, pf in t["perFamily"].items():
        cells = []
        for j in ("v2", "v1", "clef", "luna", "ens"):
            r = pf.get(j)
            cells.append("–" if not r else "%s / %s / %s / %s" % (f3(r["ap"]), f3(r["precisionAtRecall0.5"]),
                                                               f3(r["recallAtPrecision0.6"]), f3(r["recallAtPrecision0.8"])))
        print("| %s (%d) | %s |" % (f, pf["real"], " | ".join(cells)))
    print("\n## Operating points at the dev thresholds (test)\n")
    print("| detector | threshold | flags | in-family real | in-family precision [95% CI] | weighted | any-family precision | in-family recall | ships |")
    print("|---|---:|---:|---:|---|---:|---:|---:|---|")
    for name, op in sorted(t["operatingPoints"].items()):
        s = t["ship"].get(name)
        ship = "–" if s is None else ("**yes**" if s["ships"] else ("no (%d flags)" % s["flags"] if s["flags"] < 10 else "no"))
        ci = op["ci95"]
        print("| %s | %.4g | %d | %d | %s%s | %s | %s | %s | %s |" % (
            name, op["threshold"], op["flags"], op["realInFamily"], f3(op["precisionInFamily"]),
            " [%.3f, %.3f]" % tuple(ci) if ci else "", f3(op.get("weightedPrecisionInFamily")), f3(op["precisionAnyFamily"]),
            f3(op["recallInFamily"]), ship))
    print("\n## Second stage behind the rules (test; recall over all real test crops)\n")
    print("| | threshold | kept | real | precision | recall | AP within the rule flags |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    ss = t["secondStage"]
    r = ss["rulesAlone"]
    print("| measured rules alone | – | %d | %d | %s | %s | – |" % (r["flags"], r["realInFamily"], f3(r["precisionInFamily"]), f3(r["recallInFamily"])))
    for j in ("v2", "v1", "clef", "luna", "ens"):
        if j in ss:
            r = ss[j]
            print("| rules, then %s | %.4g | %d | %d | %s | %s | %s |" % (NAMES[j], r["threshold"], r["flags"], r["realInFamily"],
                                                                        f3(r["precisionInFamily"]), f3(r["recallInFamily"]), f3(r["apWithinRuleFlags"])))


if __name__ == "__main__":
    main()
