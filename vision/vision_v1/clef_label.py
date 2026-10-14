#!/usr/bin/env python3
# Labels crops with Clef through the private genclass-clef-eval worker (vision/clef/worker on wave2/clef-eval),
# with the prompt of vision/clef/eval.py (clef_prompt.py). Runs on the data node, so no image crosses the Mac.
#
#   CLEF_EVAL_URL=... CLEF_EVAL_KEY_FILE=<file> clef_label.py --items OUT/index/nat.jsonl --variant clef-img-p3 \
#       [--filter kind=cand] [--limit N] [--concurrency 32] [--max-usd 140]
#   clef_label.py spend      the spend so far, from every answer file
#
# Answers are appended to OUT/clef/<variant>/answers-<pid>.jsonl, one line per crop ({id, model, answers, usage, ms,
# wall_ms}); a run skips crops that already have an answer, so it resumes where it stopped. Before each call the
# client adds the cost of every answer written so far (all variants, input tokens at the Clef list price) and stops
# taking new crops once the next calls could pass --max-usd. Retries back off exponentially on 429, 5xx and network
# errors. The key is read from the file and never printed or written.

import argparse
import glob
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT  # noqa: E402
import clef_prompt  # noqa: E402

PRICE_PER_M = {"clef": 0.24, "clef-flash": 0.038}  # USD per million input tokens, Workers AI 2026-10-14
CLEF_DIR = os.path.join(OUT, "clef")


def answered(variant):
    done = {}
    for f in glob.glob(os.path.join(CLEF_DIR, variant, "answers-*.jsonl")):
        with open(f) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue  # a line cut by a kill
                done[r["id"]] = r
    return done


def spend_all():
    """USD of every answer written so far, by variant."""
    out = {}
    for d in glob.glob(os.path.join(CLEF_DIR, "*")):
        v = os.path.basename(d)
        if v not in clef_prompt.VARIANTS:
            continue
        price = PRICE_PER_M[clef_prompt.VARIANTS[v]["model"]]
        tok, n = 0, 0
        for r in answered(v).values():
            tok += (r.get("usage") or {}).get("input_tokens", 0)
            n += 1
        out[v] = {"calls": n, "inputTokens": tok, "usd": round(tok * price / 1e6, 4)}
    return out


def post(url, key, body, tries=9):
    data = json.dumps(body).encode()
    err = None
    for k in range(tries):
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers={"content-type": "application/json", "x-eval-key": key,
                                              "user-agent": "genclass-vision-v1/1"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                out = json.loads(r.read())
                out["wall_ms"] = round((time.time() - t0) * 1000)
                if not out.get("answers"):
                    err = "no answers"
                else:
                    return out, k
        except urllib.error.HTTPError as e:
            msg = e.read()[:200].decode(errors="replace")
            err = "HTTP %d %s" % (e.code, msg)
            if e.code in (400, 403, 404, 413):
                return {"error": err}, k
        except Exception as e:  # network errors, timeouts
            err = repr(e)[:200]
        time.sleep(min(90, 1.5 * 2 ** k) * (0.5 + random.random()))
    return {"error": err}, tries


def matches(it, filters):
    for f in filters:
        k, v = f.split("=", 1)
        if str(it.get(k)) != v:
            return False
    return True


def cmd_run(a):
    url = os.environ["CLEF_EVAL_URL"]
    key = open(os.environ["CLEF_EVAL_KEY_FILE"]).read().strip()
    v = clef_prompt.VARIANTS[a.variant]
    price = PRICE_PER_M[v["model"]]
    items = []
    for path in a.items:
        with open(path) as fh:
            items += [json.loads(l) for l in fh]
    items = [it for it in items if matches(it, a.filter or [])]
    if a.ids:
        keep = set(open(a.ids).read().split())
        items = [it for it in items if it["id"] in keep]
    done = answered(a.variant)
    todo = [it for it in items if it["id"] not in done]
    if a.shuffle:
        random.Random(a.seed).shuffle(todo)
    if a.limit:
        todo = todo[: a.limit]
    d = os.path.join(CLEF_DIR, a.variant)
    os.makedirs(d, exist_ok=True)
    base = sum(x["usd"] for x in spend_all().values())
    print("%s: %d items, %d answered, %d to run; spend so far $%.2f, cap $%.2f" % (
        a.variant, len(items), len(done), len(todo), base, a.max_usd), flush=True)
    out = open(os.path.join(d, "answers-%d.jsonl" % os.getpid()), "a")
    lock = threading.Lock()
    st = {"ok": 0, "err": 0, "tok": 0, "retries": 0, "t0": time.time(), "stop": False}
    est = 1500 * price / 1e6  # USD of one call, upper estimate, until measured

    def one(it):
        body = clef_prompt.build_request(it, v)
        res, k = post(url, key, body)
        with lock:
            st["retries"] += k
            if "error" in res:
                st["err"] += 1
                print("error %s: %s" % (it["id"], res["error"]), file=sys.stderr, flush=True)
                return
            res["id"] = it["id"]
            out.write(json.dumps(res) + "\n")
            out.flush()
            st["ok"] += 1
            st["tok"] += (res.get("usage") or {}).get("input_tokens", 0)
            n = st["ok"] + st["err"]
            if n % a.every == 0:
                dt = time.time() - st["t0"]
                print("%d/%d ok %d err %d retries %d  %.1f/s  run $%.3f  total $%.2f" % (
                    n, len(todo), st["ok"], st["err"], st["retries"], n / dt, st["tok"] * price / 1e6,
                    base + st["tok"] * price / 1e6), flush=True)

    # spend = every answer on disk (all variants, all processes; re-read once a minute) + this run's calls since then
    ref = {"t": time.time(), "disk": base, "tok": 0}
    with ThreadPoolExecutor(a.concurrency) as ex:
        pending = set()
        for it in todo:
            if time.time() - ref["t"] > 60:
                with lock:
                    out.flush()
                    tok_now = st["tok"]
                disk = sum(x["usd"] for x in spend_all().values())
                ref.update({"t": time.time(), "disk": disk, "tok": tok_now})
            with lock:
                spent = ref["disk"] + (st["tok"] - ref["tok"]) * price / 1e6
                per = (st["tok"] / st["ok"] * price / 1e6) if st["ok"] else est
            if spent + per * (len(pending) + 1) > a.max_usd:
                st["stop"] = True
                print("stopping: the next calls would pass the cap ($%.2f spent)" % spent, flush=True)
                break
            pending.add(ex.submit(one, it))
            if len(pending) >= a.concurrency * 2:
                finished, pending = wait(pending, return_when=FIRST_COMPLETED)
                for f in finished:
                    f.result()
        for f in pending:
            f.result()
    out.close()
    dt = time.time() - st["t0"]
    print(json.dumps({"variant": a.variant, "ok": st["ok"], "errors": st["err"], "retries": st["retries"], "seconds": round(dt),
                      "callsPerSecond": round((st["ok"] + st["err"]) / max(1, dt), 2), "runUsd": round(st["tok"] * price / 1e6, 4),
                      "stoppedAtCap": st["stop"]}))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("run")
    p.add_argument("--items", nargs="+", required=True)
    p.add_argument("--variant", required=True, choices=sorted(clef_prompt.VARIANTS))
    p.add_argument("--filter", action="append")
    p.add_argument("--ids")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--shuffle", action="store_true")
    p.add_argument("--seed", type=int, default=5)
    p.add_argument("--concurrency", type=int, default=32)
    p.add_argument("--max-usd", type=float, default=140.0)
    p.add_argument("--every", type=int, default=1000)
    sp.add_parser("spend")
    a = ap.parse_args()
    if a.cmd == "spend":
        s = spend_all()
        print(json.dumps({"byVariant": s, "totalUsd": round(sum(x["usd"] for x in s.values()), 4)}))
    else:
        cmd_run(a)


if __name__ == "__main__":
    main()
