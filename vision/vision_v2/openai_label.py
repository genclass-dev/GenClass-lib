#!/usr/bin/env python3
# Mac side of the OpenAI labelling: pulls batches of request bodies from the data node (oa_requests.py make), sends
# them to OpenAI's Decisions API (POST /v1/decisions, gpt-6-luna) and pushes the answers back to the node. Standard
# library only. The Batch API does not list /v1/decisions (2026-10-14), so these are standard calls with modest
# concurrency and backoff.
#
#   openai_label.py pilot --node IP --work DIR [--n 20]          one call at a time; tokens, latency, rate-limit headers
#   openai_label.py run   --node IP --work DIR [--from 0] [--to 49] [--concurrency 16] [--cap-usd 24]
#   openai_label.py spend --work DIR
#
# Invariants:
# - The key is read from ~/.jev-local/secrets/openai.key inside this process only and sent only in the Authorization
#   header to https://api.openai.com. It is never printed, logged, written, put in an environment variable or on a
#   command line; API error text passes through redact() before it is printed.
# - Spend is summed from each response's usage.input_tokens into WORK/spend.json. No call starts when the spend so
#   far plus every call in flight at the largest size seen would pass --cap-usd.
# - Request files (they hold the crops) live in WORK/req only while their batch is labelled and are deleted as soon
#   as its answers are on the node. What stays on the Mac is WORK/ans: random tokens and probability vectors.

import argparse
import gzip
import http.client
import json
import os
import random
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

API_URL = "https://api.openai.com/v1/decisions"
KEY_FILE = "~/.jev-local/secrets/openai.key"
PRICE_PER_M = 0.10  # USD per million input tokens, standard (2026-10-14); no output charge
SSH_KEY = "~/.ssh/jev_azure"
NODE_PY = "~/vv1-venv/bin/python ~/vv2-code/oa_requests.py"
NODE_ANS = "~/vision-out/vision-v2/oa/answers"
RL_HEADERS = ("x-ratelimit-limit-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-requests",
              "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens")

_KEY = None
_KEY_LOCK = threading.Lock()


def api_key():
    global _KEY
    with _KEY_LOCK:
        if _KEY is None:
            with open(os.path.expanduser(KEY_FILE)) as fh:
                _KEY = fh.read().strip()
            if not _KEY:
                sys.exit("the key file is empty")
    return _KEY


def redact(s):
    s = str(s)
    if _KEY:
        s = s.replace(_KEY, "[redacted]")
    return re.sub(r"(sk-|Bearer\s+)[A-Za-z0-9_\-\*\.]+", r"\1[redacted]", s)


class Ledger:
    def __init__(self, work, cap):
        self.path = os.path.join(work, "spend.json")
        self.cap = cap
        self.lock = threading.Lock()
        self.d = json.load(open(self.path)) if os.path.exists(self.path) else {"calls": 0, "inputTokens": 0, "maxTokens": 0}
        self.inflight = 0

    def usd(self, tokens=None):
        return (self.d["inputTokens"] if tokens is None else tokens) * PRICE_PER_M / 1e6

    def reserve(self):
        with self.lock:
            per = max(self.d["maxTokens"], 8000)
            if self.usd(self.d["inputTokens"] + (self.inflight + 1) * per) > self.cap:
                return False
            self.inflight += 1
            return True

    def settle(self, tokens):
        with self.lock:
            self.inflight -= 1
            if tokens is None:
                return
            self.d["calls"] += 1
            self.d["inputTokens"] += tokens
            self.d["maxTokens"] = max(self.d["maxTokens"], tokens)
            self.d["usdStandard"] = round(self.usd(), 4)
            tmp = self.path + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(self.d, fh)
            os.replace(tmp, self.path)


class CapReached(Exception):
    pass


_TLS = threading.local()


def connection():
    """One kept-alive HTTPS connection per thread (a new TLS handshake per call was most of the wall time)."""
    c = getattr(_TLS, "conn", None)
    if c is None:
        c = http.client.HTTPSConnection(urllib.parse.urlsplit(API_URL).netloc, timeout=180)
        _TLS.conn = c
    return c


def drop_connection():
    c = getattr(_TLS, "conn", None)
    if c is not None:
        try:
            c.close()
        except Exception:
            pass
    _TLS.conn = None


def post(body, ledger, tries=8):
    data = json.dumps(body).encode()
    path = urllib.parse.urlsplit(API_URL).path
    err = None
    for k in range(tries):
        if not ledger.reserve():
            raise CapReached()
        tokens, wait = None, None
        t0 = time.time()
        try:
            c = connection()
            c.request("POST", path, body=data, headers={
                "Content-Type": "application/json", "Authorization": "Bearer " + api_key(),
                "User-Agent": "genclass-vision-v2-label/1", "Connection": "keep-alive"})
            r = c.getresponse()
            raw = r.read()
            if r.status == 200:
                out = json.loads(raw)
                u = out.get("usage") or {}
                tokens = u.get("input_tokens") if isinstance(u.get("input_tokens"), int) else None
                pms = r.getheader("openai-processing-ms")
                rl = {h: r.getheader(h) for h in RL_HEADERS if r.getheader(h) is not None}
                if (r.getheader("connection") or "").lower() == "close":
                    drop_connection()
                return {"resp": out, "input_tokens": tokens, "wall_ms": round((time.time() - t0) * 1000),
                        "server_ms": int(float(pms)) if pms else None, "rl": rl}
            err = redact("HTTP %d %s" % (r.status, raw[:400].decode(errors="replace")))
            ra = r.getheader("retry-after")
            try:
                wait = float(ra) if ra else None
            except ValueError:
                wait = None
            if r.status in (400, 401, 403, 404, 413, 422):
                return {"error": err, "fatal": r.status in (401, 403, 404)}
        except Exception as e:  # network errors, timeouts, a connection the server closed
            err = redact(repr(e)[:300])
            drop_connection()
        finally:
            ledger.settle(tokens)
        time.sleep(min(60, wait if wait else 2 ** k + random.random()))
    return {"error": err}


def answer_record(t, out):
    ans = {}
    for x in out["resp"].get("answers", []):
        a = {"choice": x.get("choice"), "type": x.get("type")}
        if isinstance(x.get("probabilities"), list):
            a["probabilities"] = {p["value"]: float(p["probability"]) for p in x["probabilities"]}
        ans[x.get("name")] = a
    ok = all(isinstance(ans.get(q, {}).get("probabilities"), dict) for q in ("verdict", "family"))
    return {"t": t, "answers": ans, "input_tokens": out["input_tokens"], "server_ms": out["server_ms"],
            "wall_ms": out["wall_ms"]}, ok


# ---------------------------------------------------------------- node transfer


def ssh(node, cmd, stdin=None, stdout=None, timeout=600):
    args = ["ssh", "-i", os.path.expanduser(SSH_KEY), "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30",
            "-o", "BatchMode=yes", "azureuser@" + node, cmd]
    return subprocess.run(args, stdin=stdin, stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)


def fetch(node, work, k):
    """Request bodies of batch k (only the crops without an answer on the node) -> WORK/req/req-k.jsonl.gz."""
    d = os.path.join(work, "req")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "req-%d.jsonl.gz" % k)
    if os.path.exists(path):
        return path
    tmp = path + ".part"
    for attempt in range(4):
        with open(tmp, "wb") as fh:
            r = ssh(node, "%s make --batch %d --skip-answered" % (NODE_PY, k), stdout=fh)
        if r.returncode == 0:
            os.replace(tmp, path)
            return path
        print("fetch %d failed (%s); retrying" % (k, r.stderr.decode(errors="replace")[-300:]), flush=True)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError("could not fetch batch %d" % k)


def push(node, work, k):
    src = os.path.join(work, "ans", "answers-%d.jsonl" % k)
    n = sum(1 for _ in open(src))
    for attempt in range(4):
        with open(src, "rb") as fh:
            r = ssh(node, "mkdir -p %s && cat > %s/answers-%d.jsonl.tmp && mv %s/answers-%d.jsonl.tmp %s/answers-%d.jsonl && wc -l < %s/answers-%d.jsonl"
                    % (NODE_ANS, NODE_ANS, k, NODE_ANS, k, NODE_ANS, k, NODE_ANS, k), stdin=fh)
        if r.returncode == 0 and r.stdout.decode().strip() == str(n):
            return n
        print("push %d failed (rc %d); retrying" % (k, r.returncode), flush=True)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError("could not push batch %d" % k)


# ---------------------------------------------------------------- commands


def load_reqs(path):
    with gzip.open(path, "rt") as fh:
        return [json.loads(l) for l in fh]


def done_tokens(path):
    got = set()
    if os.path.exists(path):
        for line in open(path):
            try:
                got.add(json.loads(line)["t"])
            except (ValueError, KeyError):
                pass
    return got


def cmd_pilot(a):
    reqs = load_reqs(fetch(a.node, a.work, a.batch))[: a.n]
    ledger = Ledger(a.work, a.cap_usd)
    os.makedirs(os.path.join(a.work, "ans"), exist_ok=True)
    ap_ = os.path.join(a.work, "ans", "answers-%d.jsonl" % a.batch)
    have = done_tokens(ap_)
    rows = []
    with open(ap_, "a") as out:
        for r in reqs:
            if r["t"] in have:
                continue
            o = post(r["body"], ledger)
            if "error" in o:
                print("error:", o["error"], flush=True)
                if o.get("fatal"):
                    break
                continue
            rec, ok = answer_record(r["t"], o)
            out.write(json.dumps(rec) + "\n")
            rows.append((o["input_tokens"], o["wall_ms"], o["server_ms"], ok, o["rl"]))
    if rows:
        print(json.dumps({"calls": len(rows), "meanTokens": sum(x[0] or 0 for x in rows) / len(rows),
                          "maxTokens": max(x[0] or 0 for x in rows), "wallMs": sorted(x[1] for x in rows)[len(rows) // 2],
                          "serverMs": sorted(x[2] or 0 for x in rows)[len(rows) // 2], "allParsed": all(x[3] for x in rows),
                          "rateLimits": rows[-1][4], "spendUsd": round(ledger.usd(), 4)}, indent=1))


def run_batch(a, k, path, ledger, stop):
    reqs = load_reqs(path)
    ap_ = os.path.join(a.work, "ans", "answers-%d.jsonl" % k)
    have = done_tokens(ap_)
    todo = [r for r in reqs if r["t"] not in have]
    lock = threading.Lock()
    st = {"ok": 0, "err": 0, "bad": 0, "t0": time.time(), "rl": {}}
    out = open(ap_, "a")

    def one(r):
        if stop.is_set():
            return
        try:
            o = post(r["body"], ledger)
        except CapReached:
            stop.set()
            print("spend cap reached: $%.4f of $%.2f; stopping" % (ledger.usd(), ledger.cap), flush=True)
            return
        with lock:
            if "error" in o:
                st["err"] += 1
                print("error: %s" % o["error"], file=sys.stderr, flush=True)
                if o.get("fatal"):
                    stop.set()
                return
            if o["input_tokens"] is None:
                stop.set()
                print("no usage in the response; stopping so spend stays tracked", flush=True)
                return
            rec, ok = answer_record(r["t"], o)
            if not ok:  # e.g. a refusal: no probabilities to learn from (the call is still counted in the spend)
                st["bad"] += 1
                print("unparsed answer types: %s" % [a.get("type") for a in rec["answers"].values()], file=sys.stderr, flush=True)
                return
            out.write(json.dumps(rec) + "\n")
            st["ok"] += 1
            st["rl"] = o["rl"] or st["rl"]

    with ThreadPoolExecutor(a.concurrency) as ex:
        list(ex.map(one, todo))
    out.close()
    dt = time.time() - st["t0"]
    have = done_tokens(ap_)
    missing = sum(1 for r in reqs if r["t"] not in have)
    print("batch %d: %d ok, %d errors, %d unparsed, %d missing, %.1f calls/s, spend $%.4f (%d calls) rl=%s" % (
        k, st["ok"], st["err"], st["bad"], missing, st["ok"] / max(1e-9, dt), ledger.usd(), ledger.d["calls"],
        json.dumps({h.replace("x-ratelimit-", ""): v for h, v in st["rl"].items() if "remaining" in h})), flush=True)
    return missing


def cmd_run(a):
    ledger = Ledger(a.work, a.cap_usd)
    os.makedirs(os.path.join(a.work, "ans"), exist_ok=True)
    stop = threading.Event()
    ks = [k for k in range(a.start, a.to + 1) if not os.path.exists(os.path.join(a.work, "ans", "pushed-%d" % k))]
    pre = ThreadPoolExecutor(1)
    nxt = pre.submit(fetch, a.node, a.work, ks[0]) if ks else None
    for i, k in enumerate(ks):
        path = nxt.result()
        nxt = pre.submit(fetch, a.node, a.work, ks[i + 1]) if i + 1 < len(ks) else None
        missing = run_batch(a, k, path, ledger, stop)
        n = push(a.node, a.work, k)
        os.remove(path)  # the crops of this batch leave the Mac
        if missing == 0:
            open(os.path.join(a.work, "ans", "pushed-%d" % k), "w").write(str(n))
        if stop.is_set():
            break
    if nxt is not None:
        try:
            os.remove(nxt.result())
        except Exception:
            pass
    pre.shutdown()
    print("done; spend $%.4f, %d calls, %d input tokens" % (ledger.usd(), ledger.d["calls"], ledger.d["inputTokens"]), flush=True)


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    for name in ("pilot", "run"):
        p = sp.add_parser(name)
        p.add_argument("--node", required=True)
        p.add_argument("--work", required=True)
        p.add_argument("--cap-usd", type=float, default=24.0)
        if name == "pilot":
            p.add_argument("--batch", type=int, default=0)
            p.add_argument("--n", type=int, default=20)
        else:
            p.add_argument("--from", dest="start", type=int, default=0)
            p.add_argument("--to", type=int, default=49)
            p.add_argument("--concurrency", type=int, default=16)
    p = sp.add_parser("spend")
    p.add_argument("--work", required=True)
    a = ap.parse_args()
    if a.cmd == "spend":
        l = Ledger(a.work, 0)
        print(json.dumps(dict(l.d, usdStandard=round(l.usd(), 4))))
    elif a.cmd == "pilot":
        cmd_pilot(a)
    else:
        cmd_run(a)


if __name__ == "__main__":
    main()
