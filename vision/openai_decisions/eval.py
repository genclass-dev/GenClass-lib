#!/usr/bin/env python3
# OpenAI's Decisions API (POST /v1/decisions, public beta, model gpt-6-luna) as a judge of visibly broken page
# elements, on the same labelled crops, split, prompts and scoring as the Clef evaluation (vision/clef/eval.py on
# wave2/clef-eval, 3be5c2f), so the two can be compared crop for crop. Standard library plus numpy.
#
#   eval.py prepare --data DIR --work WORK              labels + facts + sidecars -> WORK/items.jsonl (the Clef split)
#   eval.py run --work WORK --variant V --split S       calls the API, caches one answer per crop under WORK/runs/V
#   eval.py tokens --work WORK --split dev --limit 100  the same text without the image, to split tokens image / text
#   eval.py latency --work WORK --variant V             one call at a time, then 40-candidate scans sent at once
#   eval.py report --work WORK --clef-work CW --out F   metrics next to Clef's (its cached answers), ensembles, diffs
#   eval.py show --work WORK --variant V --id ID        the exact request, without the image (no key needed)
#   eval.py spend --work WORK                           calls, input tokens and USD so far (from the usage fields)
#
# Invariants:
# - The API key is read from a file (default ~/.jev-local/secrets/openai.key) inside this process only, stripped,
#   and sent only in the Authorization header to https://api.openai.com. It is never printed, logged or written;
#   error text from the API is passed through redact() before it is printed.
# - Spend is tracked from each response's usage field into WORK/spend.json. A call is not started when the spend
#   so far plus every call in flight at the largest size seen would pass --cap-usd.
# - Hosts are used only to split and to bootstrap: items.jsonl carries a salted hash of the host, never the host,
#   and nothing this script writes names a crawled site. Crops and answers stay in WORK (outside git).
# - The split is by host, identical to the Clef evaluation (same salt): 20% dev for choices, 80% report. Thresholds
#   used on report are chosen on dev. "unclear" labels are excluded. Labellers' notes and rule ids never reach the
#   model.

import argparse
import base64
import hashlib
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

API_URL = "https://api.openai.com/v1/decisions"
MODEL = "gpt-6-luna"
DEFAULT_KEY_FILE = "~/.jev-local/secrets/openai.key"
PRICE_PER_M = {"standard": 0.10, "batch": 0.05}  # USD per million input tokens (Batch/Flex), no output charge
SPLIT_SALT = "clef-eval-1"  # the Clef evaluation's salt: the same dev/report split
DEV_SHARE = 0.2

# ---------------------------------------------------------------- items (as vision/clef/eval.py)


def host_group(host):
    return hashlib.sha256((SPLIT_SALT + ":" + host).encode()).hexdigest()[:12]


def is_dev(host):
    h = int(hashlib.sha256((SPLIT_SALT + ":split:" + host).encode()).hexdigest()[:8], 16)
    return h / 2**32 < DEV_SHARE


def cmd_prepare(a):
    labels = json.load(open(os.path.join(a.data, "raw/labels.json")))["labels"]
    facts = {}
    with open(os.path.join(a.data, "facts.jsonl")) as fh:
        for line in fh:
            r = json.loads(line)
            facts[r["id"]] = r
    os.makedirs(a.work, exist_ok=True)
    n = {"dev": 0, "report": 0, "unclear": 0}
    with open(os.path.join(a.work, "items.jsonl"), "w") as out:
        for x in labels:
            if x["verdict"] == "unclear":
                n["unclear"] += 1
                continue
            sc = json.load(open(os.path.join(a.data, "raw/crops", x["id"] + ".json")))
            f = facts[x["id"]]
            split = "dev" if is_dev(x["host"]) else "report"
            n[split] += 1
            out.write(json.dumps({
                "id": x["id"], "split": split, "g": host_group(x["host"]), "y": 1 if x["verdict"] == "real" else 0,
                "family": x["family"], "stratum": x["stratum"], "sources": x["sources"], "rules": x["rules"],
                "gbt": sc.get("score"), "device": x["device"], "scheme": x["scheme"], "group": x["group"],
                "crop": {"size": sc["cropSize"], "inCrop": sc["inCrop"], "viewport": sc["viewport"]},
                "el": f["el"], "anc": f["anc"], "kids": len(f["kids"]), "page": (f["page"] or {}).get("page") or {},
                "img": os.path.join(a.data, "raw/crops", x["id"] + ".jpg"),
            }) + "\n")
    print(json.dumps(n))


def load_items(work):
    with open(os.path.join(work, "items.jsonl")) as fh:
        return [json.loads(l) for l in fh]


# ---------------------------------------------------------------- the prompt: verbatim from vision/clef/eval.py

EBS = {0: "a solid colour", 1: "no opaque layer (the page canvas colour was assumed)", 2: "a background image or gradient",
       3: "an image or video behind it", 4: "a filter or blend mode", 5: "a colour that did not parse",
       6: "another element painted on top at the text centre", 7: "not found in the paint stack at its centre"}
POS = {"r": "relative", "a": "absolute", "f": "fixed", "s": "sticky"}
OVF = {"h": "hidden", "c": "clip", "a": "auto (scrolls)", "s": "scroll"}
SRC = {"same": "same-site URL", "cross": "another site's URL", "data": "inline data URL", "blob": "blob URL",
       "ph": "a placeholder-image service", "": "no usable URL"}
FIT = {"c": "contain", "v": "cover", "n": "none", "d": "scale-down"}


def rgb(c):
    if not c:
        return "unknown"
    s = "rgb(%d, %d, %d)" % (round(c[0]), round(c[1]), round(c[2]))
    if len(c) > 3 and c[3] < 1:
        s += " at %d%% alpha" % round(c[3] * 100)
    return s


def num(v, d=0):
    return ("%%.%df" % d) % v if isinstance(v, (int, float)) else "?"


def page_words(it):
    p = it["page"]
    w = []
    dev = "phone" if it["device"] == "phone" else "desktop"
    w.append("Page: %s view, viewport %s x %s px, rendered with the %s colour scheme preference." % (
        dev, p.get("vw", "?"), p.get("vh", "?"), it["scheme"]))
    cs = p.get("colorScheme") or "normal"
    w.append("The page declares color-scheme '%s'%s." % (cs, "; it switches to a dark theme of its own" if p.get("appDark") else ""))
    sw, cw = p.get("scrollW") or 0, p.get("clientW") or 0
    if sw > cw + 1:
        w.append("The page is %d px wide in a %d px viewport, so it scrolls sideways by %d px." % (sw, cw, sw - cw))
    else:
        w.append("The page does not scroll sideways.")
    res = p.get("res") or {}
    fails = [(k, res.get(k)) for k in ("cssFailed", "imgFailed", "fontFailed", "scriptFailed") if res.get(k)]
    if fails:
        w.append("Failed loads on the page: " + ", ".join("%d %s" % (v, k.replace("Failed", "")) for k, v in fails) + ".")
    if p.get("fontsStatus") and p.get("fontsStatus") != "loaded":
        w.append("Web fonts status: %s." % p["fontsStatus"])
    return " ".join(w)


def element_words(it):
    e = it["el"]
    w = []
    role = e.get("role")
    kind = "<%s>" % e["tag"] + (", role %s" % role if role else "")
    extra = []
    if e.get("disp"):
        extra.append("display %s" % e["disp"])
    if e.get("pos"):
        extra.append("position %s" % POS.get(e["pos"], e["pos"]))
    w.append("Element: %s%s." % (kind, (" (" + ", ".join(extra) + ")") if extra else ""))
    inter = []
    if e.get("ia"):
        inter.append("interactive")
    if e.get("cur"):
        inter.append("pointer cursor")
    if e.get("pen"):
        inter.append("pointer-events none (clicks pass through)")
    if e.get("dis"):
        inter.append("disabled")
    if inter:
        w.append("It is " + ", ".join(inter) + ".")
    w.append("Box: x %s, y %s, %s x %s px; %d%% of it is inside the viewport." % (
        num(e.get("x")), num(e.get("y")), num(e.get("w")), num(e.get("h")), round((e.get("inv") or 0) * 100)))
    if not e.get("vis"):
        w.append("The browser reports it as not visible (%s)." % (e.get("why") or "reason unknown"))
    # text
    if e.get("tl"):
        t = "Own text: %d characters on %s line(s), font %s px" % (e["tl"], e.get("ln", "?"), num(e.get("fs"), 1).rstrip("0").rstrip("."))
        if e.get("fw"):
            t += " weight %d" % e["fw"]
        if isinstance(e.get("lh"), (int, float)) and e["lh"] > 0:
            t += ", line height %s px" % num(e["lh"], 1).rstrip("0").rstrip(".")
        w.append(t + ".")
        flags = []
        if e.get("nw"):
            flags.append("no wrapping")
        if e.get("ell"):
            flags.append("ellipsis on overflow")
        if e.get("lcl"):
            flags.append("clamped to %d line(s)" % e["lcl"])
        if e.get("tsh"):
            flags.append("text shadow")
        if e.get("bclip"):
            flags.append("background-clip: text")
        if flags:
            w.append("Text styling: " + ", ".join(flags) + ".")
        if e.get("tspill"):
            w.append("The text extends %s px beyond the element's box." % num(e["tspill"], 1))
    elif e.get("tt"):
        w.append("No text of its own; %d characters of text inside it." % e["tt"])
    else:
        w.append("No text.")
    # colours
    w.append("Text colour %s." % rgb(e.get("c")))
    if e.get("tfc"):
        w.append("Text fill colour %s." % rgb(e["tfc"]))
    if e.get("bg"):
        w.append("Own background colour %s." % rgb(e["bg"]))
    if e.get("bgi"):
        w.append("It has a background %s." % {1: "image", 2: "gradient", 3: "image and gradient"}.get(e["bgi"], "image"))
    ebs = e.get("ebs", 0)
    w.append("Background behind it along its ancestors: %s, from %s (%s)." % (
        rgb(e.get("eb")), EBS.get(ebs, "?"), "background known" if ebs == 0 else "background not reliably known"))
    if isinstance(e.get("cr"), (int, float)):
        w.append("Text contrast against that background: %.2f:1." % e["cr"])
    if e.get("sbs") is not None:
        sbs = e["sbs"]
        if sbs in (6, 7):
            w.append("At the text centre the browser found %s." % EBS[sbs])
        if e.get("sb"):
            w.append("Background actually painted under the text centre: %s, from %s." % (rgb(e["sb"]), EBS.get(sbs, "?")))
        if isinstance(e.get("scr"), (int, float)):
            w.append("Text contrast against what is painted under it: %.2f:1." % e["scr"])
    if e.get("op") is not None or e.get("eop") is not None:
        w.append("Opacity: own %s, effective %s." % (num(e.get("op", 1), 2), num(e.get("eop", 1), 2)))
    # overflow and clipping
    if e.get("sw") is not None:
        o = "Content size %s x %s px in a %s x %s px box" % (e["sw"], e["sh"], e["cw"], e["ch"])
        ox, oy = e.get("ox"), e.get("oy")
        if ox or oy:
            o += ", overflow-x %s, overflow-y %s" % (OVF.get(ox, "visible"), OVF.get(oy, "visible"))
        w.append(o + ".")
    if e.get("nca"):
        w.append("%d ancestor(s) clip their overflow." % e["nca"])
    if e.get("cvis") is not None:
        w.append("Only %d%% of its box is inside its ancestors' clip area." % round(e["cvis"] * 100))
    if e.get("clip") or e.get("cpath"):
        w.append("It has a CSS clip or clip-path.")
    # stacking and effects
    fx = []
    if e.get("z") is not None:
        fx.append("z-index %d" % e["z"])
    if e.get("tf"):
        fx.append("a transform")
    if e.get("flt"):
        fx.append("a filter or backdrop filter")
    if e.get("an"):
        fx.append("a running animation")
    if fx:
        w.append("It has " + ", ".join(fx) + ".")
    # occlusion
    if e.get("hs") is not None:
        pts = 5
        parts = ["%d on the element itself" % e.get("hs", 0)]
        if e.get("ho"):
            parts.append("%d on a different element" % e["ho"])
        if e.get("ha"):
            parts.append("%d on an ancestor" % e["ha"])
        if e.get("hn"):
            parts.append("%d outside the viewport" % e["hn"])
        w.append("Hit test at %d points of its box: %s." % (pts, ", ".join(parts)))
    # replaced content
    if e["tag"] == "img":
        s = "Image: natural size %s x %s px, %s, %s, from %s" % (
            e.get("nw", "?"), e.get("nh", "?"), "load complete" if e.get("cmp") else "still loading",
            "decoded" if e.get("iok") else "not decoded (broken or empty)", SRC.get(e.get("src", ""), "unknown source"))
        if e.get("of"):
            s += ", object-fit %s" % FIT.get(e["of"], e["of"])
        if e.get("lazy"):
            s += ", lazy-loaded"
        w.append(s + ".")
        alt = e.get("alt", -1)
        w.append("Alt text: %s." % ("none" if alt == -1 else "empty" if alt == 0 else "%d characters" % alt))
        if e.get("dist") is not None:
            w.append("Aspect ratio differs from the image's natural ratio by %d%%." % round(e["dist"] * 100))
    elif e["tag"] == "video":
        w.append("Video: readyState %s%s." % (e.get("rs", "?"), ", media error %s" % e["verr"] if e.get("verr") else ""))
    elif e["tag"] == "svg":
        w.append("SVG: %s viewBox, %s width attribute." % ("has a" if e.get("vb") else "no", "has a" if e.get("wa") else "no"))
    if e.get("bsrc"):
        w.append("Background image from %s." % SRC.get(e["bsrc"], "unknown source"))
    if e.get("lk"):
        w.append("Text matching leak patterns: " + "; ".join("%s ('%s')" % (k, m) for k, m in e["lk"]) + ".")
    if e.get("vu") or e.get("vi"):
        w.append("CSS variables: %d declaration(s) with an undefined var(), %d with an invalid colour after substitution (%s)." % (
            e.get("vu", 0), e.get("vi", 0), ", ".join(e.get("vp", []))))
    # parent and children
    if it["anc"]:
        p = it["anc"][0]
        s = "Parent: <%s>, %s x %s px" % (p["tag"], num(p.get("w")), num(p.get("h")))
        if p.get("sw") is not None:
            s += ", content %s x %s px in a %s x %s px box" % (p["sw"], p["sh"], p["cw"], p["ch"])
            if p.get("ox") or p.get("oy"):
                s += " (overflow-x %s, overflow-y %s)" % (OVF.get(p.get("ox"), "visible"), OVF.get(p.get("oy"), "visible"))
        w.append(s + ".")
    w.append("Child elements: %d." % it["kids"])
    return " ".join(w)


def image_words(it):
    cs, ic = it["crop"]["size"], it["crop"]["inCrop"]
    return ("The image is a screenshot of the area around the element, %d x %d px; the element's box is at x %s, y %s, "
            "%s x %s px inside it (a box larger than the image continues past its edges)." % (
                cs[0], cs[1], num(ic[0]), num(ic[1]), num(ic[2]), num(ic[3])))


VERDICT_Q = "Can a visitor see and use this element as intended?"
# the Clef evaluation's p2 criteria (its dev choice)
CRITERIA_P2 = {
    "fine": ("Yes. It looks and works as its designer intended. Deliberate design is fine: muted or decorative "
             "styling, icons without text, images cropped on purpose, carousels and sliders, sticky or fixed "
             "headers, menus that scroll inside themselves, parts that are simply below the fold or past the "
             "screenshot edge."),
    "unreadable_text": ("No: text a visitor should read is unreadable, because its colour nearly matches what is "
                        "behind it, it is invisible, far too small, or garbled."),
    "hidden_control": "No: a link, button or form field is hidden or covered by another element so it cannot be used.",
    "broken_image": ("No: an image, icon or video is broken, missing, empty, visibly distorted or squashed, or shows "
                     "a placeholder instead of real content."),
    "cut_off": ("No: content is cut off or spills out: text or controls clipped mid-word, pushed past the screen "
                "edge, or the page scrolls sideways because something is too wide for the screen."),
    "overlap": "No: content overlaps other content so that one of them is hard to read or use.",
    "leak": ("No: a template or data leak is visible: placeholder copy such as lorem ipsum or example contact "
             "details, raw {{variables}}, code, 'undefined', 'null' or 'NaN'."),
    "blank": "No: a blank or empty area sits where content clearly belongs.",
}
FAMILY_Q = "If something is wrong with this element, which kind of problem is it?"
FAMILY_CRITERIA = {
    "none": "Nothing is wrong.",
    "text": "Text readability: low contrast, invisible, tiny or garbled text.",
    "dark": "A dark-mode problem: colours that do not work in the dark colour scheme.",
    "overflow": "Overflow: content cut off, spilling out of its box or past the screen edge.",
    "responsive": "Layout broken at this screen size: squashed, stacked wrongly, too wide for a phone.",
    "occlusion": "Occlusion: covered or overlapped by another element.",
    "media": "Media: broken, missing, distorted or placeholder image or video.",
    "leaks": "A template or data leak: placeholder or raw template text shown to visitors.",
    "blank": "A blank area where content belongs.",
    "controls": "A control that does not work: unclickable, disabled by mistake, unreachable.",
    "other": "Another visible problem.",
}
GUIDE = ("Judge by what the screenshot shows a visitor. The measured facts below come from the browser and often "
         "flag harmless things: a transparent layer over a link, a contrast computed against a guessed background, "
         "content that scrolls inside a box by design, an element that continues below the fold. Treat them as hints "
         "that explain what you see, never as proof that something is broken.")

# the Clef evaluation's two leaders, as Decisions requests. The Clef counterpart has the same state text.
VARIANTS = {
    "luna-img-p3": {"facts": True, "guide": True, "clef": "clef-img-p3"},      # image + facts + caution line
    "luna-imgonly-p2": {"facts": False, "guide": False, "clef": "clef-imgonly-p2"},  # image + tag only
}


def build_state(it, v):
    """The Clef evaluation's `state` text for this crop, with an image (both variants send one)."""
    parts = []
    if v["guide"]:
        parts.append(GUIDE)
    parts.append(image_words(it))
    parts.append(page_words(it) if v["facts"] else "Page: %s view, %s colour scheme." % (it["device"], it["scheme"]))
    if v["facts"]:
        parts.append(element_words(it))
    else:
        e = it["el"]
        parts.append("Element: <%s>%s." % (e["tag"], ", role %s" % e["role"] if e.get("role") else ""))
    return "\n".join(parts)


def questions():
    return [
        {"type": "choice", "name": "verdict", "instructions": VERDICT_Q,
         "choices": [{"value": k, "description": d} for k, d in CRITERIA_P2.items()]},
        {"type": "choice", "name": "family", "instructions": FAMILY_Q,
         "choices": [{"value": k, "description": d} for k, d in FAMILY_CRITERIA.items()]},
    ]


def build_request(it, v, image=True):
    content = [{"type": "input_text", "text": build_state(it, v)}]
    if image:
        b64 = base64.b64encode(open(it["img"], "rb").read()).decode()
        content.append({"type": "input_image", "image_url": "data:image/jpeg;base64," + b64})
    return {"model": MODEL, "input": [{"role": "user", "content": content}], "questions": questions()}


# ---------------------------------------------------------------- the key, the ledger, the call

_KEY = None
_KEY_LOCK = threading.Lock()


def api_key(path):
    global _KEY
    with _KEY_LOCK:
        if _KEY is None:
            with open(os.path.expanduser(path)) as fh:
                _KEY = fh.read().strip()
            if not _KEY:
                sys.exit("the key file is empty")
    return _KEY


def redact(s):
    s = str(s)
    if _KEY:
        s = s.replace(_KEY, "[redacted]")
    return re.sub(r"(sk-|Bearer\s+)[A-Za-z0-9_\-\*\.]+", r"\1[redacted]", s)


def usage_tokens(resp):
    u = resp.get("usage") or {}
    for k in ("input_tokens", "prompt_tokens", "total_tokens"):
        if isinstance(u.get(k), (int, float)):
            return int(u[k])
    return None


class Ledger:
    """Spend so far from the usage fields, kept in WORK/spend.json, and the cap check before each call."""

    def __init__(self, work, cap):
        self.path = os.path.join(work, "spend.json")
        self.cap = cap
        self.lock = threading.Lock()
        self.d = json.load(open(self.path)) if os.path.exists(self.path) else {"calls": 0, "inputTokens": 0, "maxTokens": 0, "byKind": {}}
        self.inflight = 0

    def usd(self, tokens=None):
        return (self.d["inputTokens"] if tokens is None else tokens) * PRICE_PER_M["standard"] / 1e6

    def reserve(self):
        with self.lock:
            per_call = max(self.d["maxTokens"], 8000)  # before the first answer, assume a large call
            projected = self.d["inputTokens"] + (self.inflight + 1) * per_call
            if self.usd(projected) > self.cap:
                return False
            self.inflight += 1
            return True

    def settle(self, tokens, kind):
        with self.lock:
            self.inflight -= 1
            if tokens is None:
                return
            self.d["calls"] += 1
            self.d["inputTokens"] += tokens
            self.d["maxTokens"] = max(self.d["maxTokens"], tokens)
            b = self.d["byKind"].setdefault(kind, {"calls": 0, "inputTokens": 0})
            b["calls"] += 1
            b["inputTokens"] += tokens
            self.d["usdStandard"] = round(self.usd(), 4)
            tmp = self.path + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(self.d, fh, indent=1)
            os.replace(tmp, self.path)


class CapReached(Exception):
    pass


def post(body, key_file, ledger, kind, tries=7):
    data = json.dumps(body).encode()
    err = None
    for k in range(tries):
        if not ledger.reserve():
            raise CapReached()
        tokens = None
        req = urllib.request.Request(API_URL, data=data, method="POST", headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + api_key(key_file),
            "User-Agent": "genclass-decisions-eval/1"})
        t0 = time.time()
        wait = None
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                raw = r.read()
                wall = round((time.time() - t0) * 1000)
                pms = r.headers.get("openai-processing-ms")
                out = json.loads(raw)
                tokens = usage_tokens(out)
                return {"resp": out, "wall_ms": wall, "server_ms": int(float(pms)) if pms else None,
                        "input_tokens": tokens}
        except urllib.error.HTTPError as e:
            msg = e.read()[:400].decode(errors="replace")
            err = redact("HTTP %d %s" % (e.code, msg))
            ra = e.headers.get("retry-after") if e.headers else None
            if ra:
                try:
                    wait = float(ra)
                except ValueError:
                    wait = None
            if e.code in (400, 401, 403, 404, 413, 422):
                return {"error": err, "fatal": e.code in (401, 403, 404)}
        except Exception as e:  # network errors, timeouts
            err = redact(repr(e)[:300])
        finally:
            ledger.settle(tokens, kind)
        time.sleep(min(60, wait if wait else 2 ** k + random.random()))
    return {"error": err}


def normalise(resp):
    """Answers keyed by question name, probabilities as {value: p}: the shape the Clef evaluation caches."""
    ans = {}
    for x in resp.get("answers", []):
        a = {"type": x.get("type"), "choice": x.get("choice"), "confidence": x.get("confidence")}
        if isinstance(x.get("probabilities"), list):
            a["probabilities"] = {p["value"]: float(p["probability"]) for p in x["probabilities"]}
        ans[x.get("name")] = a
    return ans


def cache_record(out):
    r = out["resp"]
    return {"model": r.get("model"), "answers": normalise(r), "usage": r.get("usage"),
            "input_tokens": out["input_tokens"], "wall_ms": out["wall_ms"], "server_ms": out["server_ms"],
            "raw": {k: v for k, v in r.items() if k not in ("usage",)}}


def run_calls(jobs, a, ledger, kind, on_result):
    """jobs: list of (key, body). Calls them a.concurrency at a time; stops cleanly at the spend cap."""
    lock = threading.Lock()
    done = [0, 0]
    stop = threading.Event()

    def one(job):
        if stop.is_set():
            return
        key, body = job
        try:
            out = post(body, a.key_file, ledger, kind)
        except CapReached:
            stop.set()
            print("spend cap reached: %.4f USD of %.2f; stopping" % (ledger.usd(), ledger.cap), flush=True)
            return
        if out.get("fatal"):
            stop.set()
        with lock:
            done[0] += 1
            if "error" in out:
                done[1] += 1
                print("error: %s" % out["error"], file=sys.stderr, flush=True)
            elif out["input_tokens"] is None:
                stop.set()
                print("no usage in the response; stopping so spend stays tracked", file=sys.stderr, flush=True)
            else:
                on_result(key, out)
            if done[0] % 100 == 0:
                print("%d/%d (%d errors), spend %.4f USD" % (done[0], len(jobs), done[1], ledger.usd()), flush=True)

    if a.concurrency <= 1:
        for j in jobs:
            one(j)
            if stop.is_set():
                break
    else:
        with ThreadPoolExecutor(a.concurrency) as ex:
            for f in as_completed([ex.submit(one, j) for j in jobs]):
                f.result()
    print("done %d, errors %d, spend so far %.4f USD (%d calls, %d input tokens)" % (
        done[0], done[1], ledger.usd(), ledger.d["calls"], ledger.d["inputTokens"]), flush=True)


def pick(items, split, limit):
    sub = [it for it in items if split == "all" or it["split"] == split]
    return sub[:limit] if limit else sub


def cmd_run(a):
    v = VARIANTS[a.variant]
    items = pick(load_items(a.work), a.split, a.limit)
    d = os.path.join(a.work, "runs", a.variant)
    os.makedirs(d, exist_ok=True)
    todo = [it for it in items if not os.path.exists(os.path.join(d, it["id"] + ".json"))]
    print("%s: %d items, %d to run" % (a.variant, len(items), len(todo)), flush=True)
    ledger = Ledger(a.work, a.cap_usd)

    def save(key, out):
        with open(os.path.join(d, key + ".json"), "w") as fh:
            json.dump(cache_record(out), fh)

    run_calls([(it["id"], build_request(it, v)) for it in todo], a, ledger, a.variant, save)


def cmd_tokens(a):
    """The image + facts state without the image, on the same crops: input tokens split into text and image."""
    v = VARIANTS["luna-img-p3"]
    items = pick(load_items(a.work), a.split, a.limit)
    path = os.path.join(a.work, "tokens-textonly.json")
    got = json.load(open(path)) if os.path.exists(path) else {}
    todo = [it for it in items if it["id"] not in got]
    ledger = Ledger(a.work, a.cap_usd)
    lock = threading.Lock()

    def save(key, out):
        with lock:
            got[key] = out["input_tokens"]
            with open(path, "w") as fh:
                json.dump(got, fh)

    run_calls([(it["id"], build_request(it, v, image=False)) for it in todo], a, ledger, "textonly", save)


def cmd_latency(a):
    """One call at a time (unloaded), then 40-candidate scans sent at once. Answers are not cached or scored."""
    v = VARIANTS[a.variant]
    items = [it for it in load_items(a.work) if it["split"] == "report"]
    rng = random.Random(11)
    rng.shuffle(items)
    ledger = Ledger(a.work, a.cap_usd)
    seq = []
    for it in items[: a.n]:
        try:
            out = post(build_request(it, v), a.key_file, ledger, "latency")
        except CapReached:
            sys.exit("spend cap reached")
        if "error" not in out:
            seq.append((out["server_ms"] or 0, out["wall_ms"], out["input_tokens"]))
    scans = []
    for b in range(a.scans):
        batch = items[a.n + b * 40: a.n + (b + 1) * 40]
        bodies = [build_request(it, v) for it in batch]
        t0 = time.time()
        with ThreadPoolExecutor(40) as ex:
            outs = list(ex.map(lambda body: post(body, a.key_file, ledger, "latency"), bodies))
        scans.append({"wallMs": round((time.time() - t0) * 1000), "errors": sum(1 for o in outs if "error" in o),
                      "serverMsMax": max((o.get("server_ms") or 0 for o in outs), default=0),
                      "wallMsMaxCall": max((o.get("wall_ms") or 0 for o in outs), default=0)})
    ms = np.array([x[0] for x in seq])
    wall = np.array([x[1] for x in seq])
    res = {"variant": a.variant, "sequentialCalls": len(seq), "serverMsMedian": int(np.median(ms)),
           "serverMsP95": int(np.percentile(ms, 95)), "wallMsMedian": int(np.median(wall)),
           "wallMsP95": int(np.percentile(wall, 95)), "scans40": scans}
    with open(os.path.join(a.work, "latency-%s.json" % a.variant), "w") as fh:
        json.dump(res, fh, indent=1)
    print(json.dumps(res))


def cmd_spend(a):
    l = Ledger(a.work, 0)
    print(json.dumps(dict(l.d, usdStandard=round(l.usd(), 4)), indent=1))


def cmd_show(a):
    it = {x["id"]: x for x in load_items(a.work)}[a.id]
    body = build_request(it, VARIANTS[a.variant])
    body["input"][0]["content"] = [c for c in body["input"][0]["content"] if c["type"] != "input_image"] + [
        {"type": "input_image", "image_url": "data:image/jpeg;base64,<omitted>"}]
    print(json.dumps(body, indent=1))


# ---------------------------------------------------------------- metrics (as vision/clef/eval.py)


def curve(y, s):
    """Precision and recall at every distinct threshold, scores descending (ties as one step)."""
    y = np.asarray(y, float)
    s = np.asarray(s, float)
    o = np.argsort(-s, kind="mergesort")
    y, s = y[o], s[o]
    tp = np.cumsum(y)
    fp = np.cumsum(1 - y)
    last = np.r_[np.where(np.diff(s) != 0)[0], len(s) - 1]
    P = tp[last] / (tp[last] + fp[last])
    R = tp[last] / max(1, y.sum())
    return P, R, s[last]


def ap(y, s):
    P, R, _ = curve(y, s)
    r_prev = np.r_[0, R[:-1]]
    return float(np.sum((R - r_prev) * P))


def auc(y, s):
    y = np.asarray(y)
    s = np.asarray(s, float)
    pos, neg = s[y == 1], s[y == 0]
    if not len(pos) or not len(neg):
        return None
    allv = np.r_[pos, neg]
    order = np.argsort(allv, kind="mergesort")
    sv = allv[order]
    r = np.empty(len(allv))
    i = 0
    while i < len(sv):
        j = i
        while j + 1 < len(sv) and sv[j + 1] == sv[i]:
            j += 1
        r[order[i: j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return float((r[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def p_at_r(y, s, r0):
    P, R, _ = curve(y, s)
    ok = R >= r0 - 1e-9
    return float(P[ok].max()) if ok.any() else None


def r_at_p(y, s, p0):
    P, R, _ = curve(y, s)
    ok = P >= p0 - 1e-9
    return float(R[ok].max()) if ok.any() else 0.0


def at_threshold(y, s, t):
    y = np.asarray(y)
    s = np.asarray(s, float)
    pred = s >= t
    tp = int((pred & (y == 1)).sum())
    fp = int((pred & (y == 0)).sum())
    return {"threshold": round(float(t), 4), "flagged": int(pred.sum()), "tp": tp, "fp": fp,
            "precision": round(tp / max(1, tp + fp), 3), "recall": round(tp / max(1, int((y == 1).sum())), 3)}


def rnd(v):
    return None if v is None else round(v, 3)


def summary(y, s):
    y = np.asarray(y)
    if (y == 1).sum() == 0:
        return None
    return {"n": int(len(y)), "real": int((y == 1).sum()), "ap": rnd(ap(y, s)), "rocAuc": rnd(auc(y, s)),
            "precisionAtRecall0.5": rnd(p_at_r(y, s, 0.5)), "recallAtPrecision0.6": rnd(r_at_p(y, s, 0.6)),
            "recallAtPrecision0.8": rnd(r_at_p(y, s, 0.8))}


def groups_of(items):
    g = {}
    for k, it in enumerate(items):
        g.setdefault(it["g"], []).append(k)
    return [np.array(v) for v in g.values()]


def bootstrap(items, scores, stat, n=1000, seed=7):
    """Host-level bootstrap 95% interval of stat(y, s1, s2, ...) over one or more aligned score arrays."""
    groups = groups_of(items)
    rng = np.random.default_rng(seed)
    y = np.array([it["y"] for it in items])
    S = [np.asarray(s, float) for s in scores]
    vals = []
    for _ in range(n):
        idx = np.concatenate([groups[p] for p in rng.integers(0, len(groups), len(groups))])
        if y[idx].sum() == 0:
            continue
        v = stat(y[idx], *[s[idx] for s in S])
        if v is not None:
            vals.append(v)
    if not vals:
        return None
    return [round(float(np.percentile(vals, 2.5)), 3), round(float(np.percentile(vals, 97.5)), 3)]


def paired_ap_diff(items, sa, sb):
    y = np.array([it["y"] for it in items])
    d = ap(y, sa) - ap(y, sb)
    ci = bootstrap(items, [sa, sb], lambda yy, a_, b_: ap(yy, a_) - ap(yy, b_), n=2000)
    verdict = "higher" if ci and ci[0] > 0 else "lower" if ci and ci[1] < 0 else "no clear difference"
    return {"diff": rnd(d), "ci95": ci, "verdict": verdict}


def threshold_for_recall(y, s, r0):
    P, R, T = curve(y, s)
    ok = np.where(R >= r0 - 1e-9)[0]
    return float(T[ok[0]]) if len(ok) else float(T[-1])


# the v1 rules that look for each labelling family (as the Clef evaluation)
FAMILY_RULES = {"media": {"image-broken", "image-distorted", "media-failed", "text-placeholder"},
                "overflow": {"page-overflow-x"}, "occlusion": {"control-unreachable", "click-blocked"},
                "dark": {"text-invisible", "css-var-undefined"}, "text": {"text-invisible", "css-var-undefined", "font-failed"},
                "leaks": {"text-template-leak", "text-placeholder"}}
FAMILIES = ["none", "text", "dark", "overflow", "responsive", "occlusion", "media", "leaks", "blank", "controls", "other"]


def load_runs(d, items):
    out = {}
    if not os.path.isdir(d):
        return out
    for it in items:
        p = os.path.join(d, it["id"] + ".json")
        if os.path.exists(p):
            out[it["id"]] = json.load(open(p))
    return out


def any_problem(ans):
    return 1.0 - ans["answers"]["family"]["probabilities"].get("none", 0.0)


def not_fine(ans):
    return 1.0 - ans["answers"]["verdict"]["probabilities"].get("fine", 0.0)


class Detector:
    """Per-crop scores for one judge, or the average of two: its score (anyProblem unless `use` says notFine), the
    other score, the family probabilities and the top family."""

    def __init__(self, name, ans=None, parts=None, use="anyProblem"):
        self.name = name
        self.use = use
        self.refusals = 0
        if parts:  # an ensemble: the mean of its parts' scores and probabilities, on the crops every part answered
            keys = set.intersection(*[set(p.score) for p in parts])
            self.use = "+".join(p.use for p in parts)
            self.score = {k: float(np.mean([p.score[k] for p in parts])) for k in keys}
            self.notf = {k: float(np.mean([p.notf[k] for p in parts])) for k in keys}
            self.fam = {k: {f: float(np.mean([p.fam[k].get(f, 0.0) for p in parts])) for f in FAMILIES} for k in keys}
        else:
            ok = {k: x for k, x in ans.items() if x["answers"].get("family", {}).get("type") == "choice"
                  and x["answers"].get("verdict", {}).get("type") == "choice"}
            self.refusals = len(ans) - len(ok)
            fn = not_fine if use == "notFine" else any_problem
            self.score = {k: fn(x) for k, x in ok.items()}
            self.notf = {k: not_fine(x) for k, x in ok.items()}
            self.fam = {k: x["answers"]["family"]["probabilities"] for k, x in ok.items()}
        self.top = {k: max(FAMILIES, key=lambda f: v.get(f, 0.0)) for k, v in self.fam.items()}

    def covers(self, items):
        return all(it["id"] in self.score for it in items)


def cmd_report(a):
    items = load_items(a.work)
    clef_items = {it["id"]: it for it in load_items(a.clef_work)}
    same = all(clef_items.get(it["id"], {}).get("split") == it["split"] and clef_items[it["id"]]["y"] == it["y"]
               for it in items) and len(clef_items) == len(items)
    by = {"dev": [it for it in items if it["split"] == "dev"], "report": [it for it in items if it["split"] == "report"]}
    rep, dev = by["report"], by["dev"]
    fam_counts = {}
    for it in rep:
        if it["y"]:
            fam_counts[it["family"]] = fam_counts.get(it["family"], 0) + 1
    big = sorted([f for f, c in fam_counts.items() if c >= 15], key=lambda f: -fam_counts[f])
    res = {"split": {k: {"n": len(v), "real": sum(it["y"] for it in v), "hosts": len({it["g"] for it in v})} for k, v in by.items()},
           "sameSplitAndLabelsAsClef": same, "reportRealByFamily": fam_counts, "familiesReported": big,
           "primaryScore": "anyProblem (as Clef); /notFine names use 1 - P(verdict = fine)", "detectors": {}, "pairedApDifferences": {}, "perFamilyApDifferences": {}}

    # the rules: overall and each family against only the rules that look for it
    y_rep = np.array([it["y"] for it in rep])
    fl = [i for i, it in enumerate(rep) if it["rules"]]
    tp = int(y_rep[fl].sum())
    res["rulesV1"] = {"flagged": len(fl), "tp": tp, "precision": rnd(tp / len(fl)), "recall": rnd(tp / y_rep.sum())}
    own = {}
    for f in big:
        k = [it for it in rep if it["y"] == 0 or it["family"] == f]
        flk = [it for it in k if set(it["rules"]) & FAMILY_RULES.get(f, set())]
        t = sum(it["y"] for it in flk)
        own[f] = {"rules": sorted(FAMILY_RULES.get(f, set())), "flagged": len(flk), "tp": t,
                  "precision": rnd(t / max(1, len(flk))), "recall": rnd(t / max(1, sum(it["y"] for it in k)))}
    res["rulesV1OwnFamily"] = own

    # judges: ours (under both scores), Clef's cached answers, and averages of the two
    det = {}
    for v in VARIANTS:
        ans = load_runs(os.path.join(a.work, "runs", v), items)
        if ans:
            det[v] = Detector(v, ans)
            det[v + "/notFine"] = Detector(v + "/notFine", ans, use="notFine")
    for cv in ("clef-img-p3", "clef-imgonly-p2"):
        ans = load_runs(os.path.join(a.clef_work, "runs", cv), items)
        if ans:
            det[cv] = Detector(cv, ans)
    for v, cfg in VARIANTS.items():  # like for like: the same prompt, anyProblem for both
        if v in det and cfg["clef"] in det:
            det["ens-" + v[5:]] = Detector("ens-" + v[5:], parts=[det[v], det[cfg["clef"]]])
    # each judge's dev choice (prompt and score chosen on dev), averaged
    if a.dev_choice and a.dev_choice in det and "clef-img-p3" in det and a.dev_choice != "luna-img-p3":
        det["ens-devchoices"] = Detector("ens-devchoices", parts=[det[a.dev_choice], det["clef-img-p3"]])
    res["devChoice"] = {"openai": a.dev_choice, "clef": "clef-img-p3"}

    dev_thr = {}
    for name, D in det.items():
        e = {"score": D.use, "refusals": D.refusals}
        if D.covers(dev):
            e["dev"] = {s: summary([it["y"] for it in dev], [m[it["id"]] for it in dev]) for s, m in (("score", D.score), ("notFine", D.notf))}
            dev_thr[name] = threshold_for_recall([it["y"] for it in dev], [D.score[it["id"]] for it in dev], 0.5)
        if D.covers(rep):
            s = np.array([D.score[it["id"]] for it in rep])
            r = {"all": summary(y_rep, s)}
            r["all"]["apCI"] = bootstrap(rep, [s], ap)
            r["all"]["pAtR05CI"] = bootstrap(rep, [s], lambda yy, ss: p_at_r(yy, ss, 0.5))
            r["notFine"] = summary(y_rep, [D.notf[it["id"]] for it in rep])
            r["curve"] = {"%.1f" % r0: rnd(p_at_r(y_rep, s, r0)) for r0 in (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)}
            r["atRulesRecall"] = {"recall": res["rulesV1"]["recall"], "precision": rnd(p_at_r(y_rep, s, res["rulesV1"]["recall"]))}
            o = np.argsort(s, kind="mergesort")
            r["lowEnd"] = {"%.1f" % sh: {"crops": int(len(o) * sh), "real": int(y_rep[o[: int(len(o) * sh)]].sum())} for sh in (0.5, 0.7, 0.8)}
            r["byStratum"] = {}
            for st in ("rules", "gbt", "random"):
                k = [i for i, it in enumerate(rep) if it["stratum"] == st]
                r["byStratum"][st] = summary(y_rep[k], s[k])
            r["byFamily"] = {}
            for f in big:
                k = [i for i, it in enumerate(rep) if it["y"] == 0 or it["family"] == f]
                yk = y_rep[k]
                own_s = np.array([D.fam[rep[i]["id"]].get(f, 0.0) for i in k])
                blk = {"score": summary(yk, s[k]), "ownProbability": summary(yk, own_s)}
                r0 = own[f]["recall"]
                blk["atOwnRulesRecall"] = {"recall": r0, "precisionOwnProbability": rnd(p_at_r(yk, own_s, r0)),
                                           "precisionScore": rnd(p_at_r(yk, s[k], r0))}
                fr = [rep[i]["id"] for i in k if rep[i]["y"]]
                tops = {}
                for cid in fr:
                    tops[D.top[cid]] = tops.get(D.top[cid], 0) + 1
                blk["topFamilyOfReals"] = tops
                r["byFamily"][f] = blk
            reals = [it for it in rep if it["y"]]
            r["familyTop1OnReal"] = rnd(sum(1 for it in reals if D.top[it["id"]] == it["family"]) / len(reals))
            if name in dev_thr:  # the scanner's use: a second stage on the rule-flagged candidates
                t = dev_thr[name]
                kept = [i for i in fl if s[i] >= t]
                tpk = int(y_rep[kept].sum())
                stage = {"threshold": round(t, 4), "flagged": len(kept), "tp": tpk,
                         "precision": rnd(tpk / max(1, len(kept))), "recall": rnd(tpk / y_rep.sum()), "byRule": {}}
                for i in fl:
                    for rule in rep[i]["rules"]:
                        b = stage["byRule"].setdefault(rule, {"flagged": 0, "real": 0, "kept": 0, "keptReal": 0})
                        b["flagged"] += 1
                        b["real"] += int(rep[i]["y"])
                        if s[i] >= t:
                            b["kept"] += 1
                            b["keptReal"] += int(rep[i]["y"])
                r["secondStage"] = stage
                r["allCropsAtDevThreshold"] = at_threshold(y_rep, s, t)
                yf = y_rep[fl]
                r["withinRuleFlagged"] = summary(yf, s[fl])
            e["report"] = r
        res["detectors"][name] = e

    # paired AP differences on report (host-level bootstrap, 2,000 resamples)
    dc = a.dev_choice or ""
    pairs = [("luna-img-p3", "clef-img-p3"), ("luna-imgonly-p2", "clef-imgonly-p2"),  # like for like
             (dc, "clef-img-p3"), (dc, "clef-imgonly-p2"),  # dev choice against Clef's dev choice and report leader
             ("luna-imgonly-p2", "luna-img-p3"), ("luna-img-p3/notFine", "luna-img-p3"),
             ("ens-img-p3", "clef-img-p3"), ("ens-img-p3", "luna-img-p3"),
             ("ens-imgonly-p2", "clef-imgonly-p2"), ("ens-imgonly-p2", "luna-imgonly-p2"),
             ("ens-devchoices", "clef-img-p3"), ("ens-devchoices", "clef-imgonly-p2"), ("ens-devchoices", dc)]
    for x, z in pairs:
        if x in det and z in det and det[x].covers(rep) and det[z].covers(rep):
            sx = np.array([det[x].score[it["id"]] for it in rep])
            sz = np.array([det[z].score[it["id"]] for it in rep])
            res["pairedApDifferences"]["%s minus %s" % (x, z)] = paired_ap_diff(rep, sx, sz)
            # per family: each one's score and the family's own probability, that family's reals against every "not"
            pf = {}
            for f in big:
                sub = [it for it in rep if it["y"] == 0 or it["family"] == f]
                pf[f] = {"score": paired_ap_diff(sub, np.array([det[x].score[it["id"]] for it in sub]),
                                                 np.array([det[z].score[it["id"]] for it in sub])),
                         "ownProbability": paired_ap_diff(sub, np.array([det[x].fam[it["id"]].get(f, 0.0) for it in sub]),
                                                          np.array([det[z].fam[it["id"]].get(f, 0.0) for it in sub]))}
            res["perFamilyApDifferences"]["%s minus %s" % (x, z)] = pf

    # tokens, latency and cost from our cached answers
    res["tokensLatency"] = {}
    for v in VARIANTS:
        ans = load_runs(os.path.join(a.work, "runs", v), items)
        if not ans:
            continue
        xs = list(ans.values())
        tok = np.array([x["input_tokens"] for x in xs], float)
        wall = np.array([x["wall_ms"] for x in xs], float)
        srv = np.array([x["server_ms"] for x in xs if x.get("server_ms") is not None], float)
        tl = {"calls": len(xs), "inputTokensMean": round(float(tok.mean()), 1), "inputTokensMedian": int(np.median(tok)),
              "inputTokensP95": int(np.percentile(tok, 95)),
              "wallMsMedian": int(np.median(wall)), "wallMsP95": int(np.percentile(wall, 95)),
              "usdPer1000Standard": round(float(tok.mean()) * 1000 * PRICE_PER_M["standard"] / 1e6, 4),
              "usdPer1000Batch": round(float(tok.mean()) * 1000 * PRICE_PER_M["batch"] / 1e6, 4),
              "usdPerScan40Standard": round(float(tok.mean()) * 40 * PRICE_PER_M["standard"] / 1e6, 5)}
        if len(srv):
            tl["serverMsMedian"] = int(np.median(srv))
            tl["serverMsP95"] = int(np.percentile(srv, 95))
        details = [x.get("usage") or {} for x in xs]
        tl["usageKeys"] = sorted({k for u in details for k in u})
        # the pilot: the first 100 dev crops, run one call at a time (run --limit 100 --concurrency 1)
        px = [ans[it["id"]] for it in dev[:100] if it["id"] in ans]
        if px:
            pt = np.array([x["input_tokens"] for x in px], float)
            pw = np.array([x["wall_ms"] for x in px], float)
            ps = np.array([x["server_ms"] for x in px if x.get("server_ms") is not None], float)
            tl["pilot"] = {"calls": len(px), "inputTokensMean": round(float(pt.mean()), 1),
                           "inputTokensP95": int(np.percentile(pt, 95)), "wallMsMedian": int(np.median(pw)),
                           "wallMsP95": int(np.percentile(pw, 95)),
                           "serverMsMedian": int(np.median(ps)) if len(ps) else None,
                           "serverMsP95": int(np.percentile(ps, 95)) if len(ps) else None}
        res["tokensLatency"][v] = tl
    p = os.path.join(a.work, "tokens-textonly.json")
    if os.path.exists(p):
        txt = json.load(open(p))
        ans = load_runs(os.path.join(a.work, "runs", "luna-img-p3"), items)
        both = [k for k in txt if k in ans]
        if both:
            t_txt = np.array([txt[k] for k in both], float)
            t_all = np.array([ans[k]["input_tokens"] for k in both], float)
            res["tokenSplit"] = {"crops": len(both), "textTokensMean": round(float(t_txt.mean()), 1),
                                 "imageTokensMean": round(float((t_all - t_txt).mean()), 1),
                                 "imageTokensMedian": int(np.median(t_all - t_txt)),
                                 "imageTokensP95": int(np.percentile(t_all - t_txt, 95)),
                                 "totalTokensMean": round(float(t_all.mean()), 1)}
    res["latencyRuns"] = {}
    for v in VARIANTS:
        p = os.path.join(a.work, "latency-%s.json" % v)
        if os.path.exists(p):
            res["latencyRuns"][v] = json.load(open(p))
    sp = os.path.join(a.work, "spend.json")
    if os.path.exists(sp):
        s_ = json.load(open(sp))
        res["spend"] = {"calls": s_["calls"], "inputTokens": s_["inputTokens"],
                        "usdStandard": round(s_["inputTokens"] * PRICE_PER_M["standard"] / 1e6, 4),
                        "byKind": s_.get("byKind", {})}
    with open(a.out, "w") as fh:
        json.dump(res, fh, indent=1)
    for name, e in res["detectors"].items():
        print(name, json.dumps((e.get("report") or {}).get("all") or (e.get("dev") or {}).get("score")))


def main():
    p0 = argparse.ArgumentParser()
    sp = p0.add_subparsers(dest="cmd", required=True)

    def common(p, key=True):
        p.add_argument("--work", required=True)
        if key:
            p.add_argument("--key-file", default=DEFAULT_KEY_FILE)
            p.add_argument("--cap-usd", type=float, default=14.5)
            p.add_argument("--concurrency", type=int, default=8)

    p = sp.add_parser("prepare")
    p.add_argument("--data", required=True)
    p.add_argument("--work", required=True)
    p = sp.add_parser("run")
    common(p)
    p.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    p.add_argument("--split", default="dev", choices=["dev", "report", "all"])
    p.add_argument("--limit", type=int, default=0)
    p = sp.add_parser("tokens")
    common(p)
    p.add_argument("--split", default="dev", choices=["dev", "report", "all"])
    p.add_argument("--limit", type=int, default=100)
    p = sp.add_parser("latency")
    common(p)
    p.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    p.add_argument("--n", type=int, default=100)
    p.add_argument("--scans", type=int, default=5)
    p = sp.add_parser("report")
    common(p, key=False)
    p.add_argument("--clef-work", required=True)
    p.add_argument("--dev-choice", help="detector chosen on dev, e.g. luna-img-p3 or luna-img-p3/notFine")
    p.add_argument("--out", required=True)
    p = sp.add_parser("show")
    common(p, key=False)
    p.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    p.add_argument("--id", required=True)
    p = sp.add_parser("spend")
    common(p, key=False)
    a = p0.parse_args()
    {"prepare": cmd_prepare, "run": cmd_run, "tokens": cmd_tokens, "latency": cmd_latency, "report": cmd_report,
     "show": cmd_show, "spend": cmd_spend}[a.cmd](a)


if __name__ == "__main__":
    main()
