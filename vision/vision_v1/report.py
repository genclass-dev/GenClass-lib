#!/usr/bin/env python3
# Markdown tables from the evaluation JSONs (aggregates only), for RESULTS.md.
#
#   report.py --final OUT/test/results-final.json --dev MODEL/eval-dev-full-any.json --export MODEL/export/export.json

import argparse
import json


def f3(v):
    return "–" if v is None else ("%.3f" % v if isinstance(v, float) else str(v))


def rk(r):
    if not r:
        return "– | – | – | –"
    return "%s | %s | %s | %s" % (f3(r["ap"]), f3(r["precisionAtRecall0.5"]), f3(r["recallAtPrecision0.6"]), f3(r["recallAtPrecision0.8"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--final", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--export", default="")
    a = ap.parse_args()
    F = json.load(open(a.final))
    D = json.load(open(a.dev))
    print("## Ranking, any problem (test)\n")
    print("| detector | slice | crops | real | AP | P at R 0.5 | R at P 0.6 | R at P 0.8 |")
    print("|---|---|---:|---:|---:|---:|---:|---:|")
    for name in ("student", "clef", "gbtSmallV1"):
        for sl, r in F["ranking"][name].items():
            if r:
                print("| %s | %s | %d | %d | %s |" % (name, sl, r["n"], r["real"], rk(r)))
    print("\n## Clef prompts (test)\n")
    for v, d in F.get("clefVariants", {}).items():
        for sl, r in d.items():
            if r:
                print("| %s | %s | %d | %d | %s |" % (v, sl, r["n"], r["real"], rk(r)))
    print("\n## Per family vs Clef (test, families with >= 15 in-family real)\n")
    print("| family | real | student AP | Clef AP | diff [95% CI] | verdict |")
    print("|---|---:|---:|---:|---|---|")
    for f, v in F["vsClef"].items():
        print("| %s | %d | %s | %s | %s %s | %s |" % (f, v["real"], f3(v["studentAP"]), f3(v["clefAP"]), f3(v["diff"]), v["ci95"], v["verdict"]))
    print("\n## Operating points at dev thresholds (test)\n")
    print("| detector | dev threshold | flags | in-family real | precision in-family [95% CI] | weighted | any-family precision | recall in-family | ships |")
    print("|---|---:|---:|---:|---|---:|---:|---:|---|")
    for name, op in sorted(F["operatingPoints"].items()):
        sh = F["ship"].get(name, {}).get("ships")
        print("| %s | %s | %d | %d | %s %s | %s | %s | %s | %s |" % (
            name, f3(F["thresholds"].get(name)), op["flags"], op["realInFamily"], f3(op["precisionInFamily"]), op["ci95"],
            f3(op.get("weightedPrecisionInFamily")), f3(op["precisionAnyFamily"]), f3(op["recallInFamily"]),
            "–" if sh is None else ("yes" if sh else "no")))
    print("\nno dev threshold: " + ", ".join(sorted(k for k, v in F["thresholds"].items() if v is None)))
    print("\n## Second stage behind the rules (test)\n")
    for k, op in F["secondStage"].items():
        print("| %s | %d | %d | %s | %s |" % (k, op["flags"], op["realInFamily"], f3(op["precisionInFamily"]), f3(op["recallInFamily"])))
    print("\n## Dev (round-2 labelled crops)\n")
    for name in ("student", "clef", "gbtSmallV1"):
        for sl, r in D["dev"][name].items():
            if r:
                print("| %s | %s | %d | %d | %s |" % (name, sl, r["n"], r["real"], rk(r)))
    for f, v in D["dev"].get("clefReportSplitByFamily", {}).items():
        print("| %s (report split) | %d | student %s | clef %s |" % (f, v["real"], rk(v["student"]), rk(v["clef"])))
    for v, r in D["dev"].get("clefVariantsOnExtraLabels", {}).items():
        print("| extra labels %s | %s |" % (v, rk(r)))
    for k, op in D["dev"].get("secondStage", {}).items():
        print("| dev second stage %s | %d | %d | %s | %s |" % (k, op["flags"], op["realInFamily"], f3(op["precisionInFamily"]), f3(op["recallInFamily"])))
    if a.export:
        print("\n## Export\n")
        print(json.dumps(json.load(open(a.export)), indent=1))


if __name__ == "__main__":
    main()
