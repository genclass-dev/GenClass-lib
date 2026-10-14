#!/usr/bin/env python3
# Clef as a judge of visibly broken page elements: builds the prompt from the measured facts of each labelled crop,
# calls the private genclass-clef-eval worker (vision/clef/worker), and scores the answers against the person labels
# next to the v1 rules and the v1 gbt-small model. Standard library plus numpy and Pillow (the outline variant).
#
#   eval.py prepare --data DIR --work WORK          labels + facts + sidecars -> WORK/items.jsonl (dev/report split)
#   eval.py run --work WORK --variant V --split S   calls the worker, caches one answer per crop under WORK/runs/V
#   eval.py report --work WORK --out FILE.json      metrics for every variant that has answers
#   eval.py latency --work WORK --variant V         one call at a time, then 40-candidate scans sent at once
#
# Invariants:
# - Hosts are used only to split and to bootstrap: items.jsonl carries a salted hash of the host, never the host,
#   and nothing this script writes names a crawled site. Crops and answers stay in WORK (outside git).
# - The split is by host (every crop of a site is on one side): 20% dev for prompt choices, 80% report. Numbers in
#   RESULTS.md come from the report side only; thresholds used on it are chosen on dev.
# - "unclear" labels are excluded. The labellers' notes and the rule ids never reach the model.
# - The worker URL comes from CLEF_EVAL_URL and the key from the file named by CLEF_EVAL_KEY_FILE; the key is never
#   printed or written.

import argparse
import base64
import hashlib
import io
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

SPLIT_SALT = "clef-eval-1"
DEV_SHARE = 0.2
PRICE_PER_M = {"clef": 0.24, "clef-flash": 0.038}  # USD per million input tokens, Workers AI pricing 2026-10-14

# ---------------------------------------------------------------- items


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


# ---------------------------------------------------------------- the prompt: measured facts in plain words

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


# ---------------------------------------------------------------- questions (prompt versions)

VERDICT_Q = "Can a visitor see and use this element as intended?"

CRITERIA = {
    "p1": {
        "fine": "Yes: it looks and works as intended.",
        "unreadable_text": "Text is unreadable: too little contrast, invisible, too small or garbled.",
        "hidden_control": "A link, button or field is hidden, covered or cannot be clicked.",
        "broken_image": "An image or media is broken, missing, distorted or a placeholder.",
        "cut_off": "Content is cut off or overflows its container or the screen edge.",
        "overlap": "Content overlaps other content.",
        "leak": "A template or data leak: placeholder text, raw variables, code, undefined or lorem ipsum.",
        "blank": "A blank area where content belongs.",
    },
    "p2": {
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
    },
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

# variant -> model, what the state holds, image treatment, prompt version
VARIANTS = {
    "clef-img-p1": {"model": "clef", "facts": True, "image": "plain", "prompt": "p1"},
    "clef-img-p2": {"model": "clef", "facts": True, "image": "plain", "prompt": "p2"},
    "clef-box-p2": {"model": "clef", "facts": True, "image": "outline", "prompt": "p2"},
    "clef-text-p2": {"model": "clef", "facts": True, "image": None, "prompt": "p2"},
    "clef-imgonly-p2": {"model": "clef", "facts": False, "image": "plain", "prompt": "p2"},
    "flash-text-p2": {"model": "clef-flash", "facts": True, "image": None, "prompt": "p2"},
    # p3: the p2 criteria, plus a first line that makes the screenshot the evidence and the facts hints
    "clef-img-p3": {"model": "clef", "facts": True, "image": "plain", "prompt": "p2", "guide": True},
    "clef-box-p3": {"model": "clef", "facts": True, "image": "outline", "prompt": "p2", "guide": True},
    "clef-boxonly-p2": {"model": "clef", "facts": False, "image": "outline", "prompt": "p2"},
    "clef-text-p3": {"model": "clef", "facts": True, "image": None, "prompt": "p2", "guide": True},
    "flash-text-p3": {"model": "clef-flash", "facts": True, "image": None, "prompt": "p2", "guide": True},
    "flash-img-p3": {"model": "clef-flash", "facts": True, "image": "plain", "prompt": "p2", "guide": True},
}

GUIDE = ("Judge by what the screenshot shows a visitor. The measured facts below come from the browser and often "
         "flag harmless things: a transparent layer over a link, a contrast computed against a guessed background, "
         "content that scrolls inside a box by design, an element that continues below the fold. Treat them as hints "
         "that explain what you see, never as proof that something is broken.")
# the same caution when there is no screenshot
GUIDE_TEXT = ("Judge whether a visitor would see a problem. The measured facts below come from the browser and often "
              "flag harmless things: a transparent layer over a link, a contrast computed against a guessed background, "
              "content that scrolls inside a box by design, an element that continues below the fold. A fact alone is "
              "not proof that something is broken.")


def build_request(it, v):
    parts = []
    if v.get("guide"):
        parts.append(GUIDE if v["image"] else GUIDE_TEXT)
    if v["image"]:
        parts.append(image_words(it))
    parts.append(page_words(it) if v["facts"] else "Page: %s view, %s colour scheme." % (it["device"], it["scheme"]))
    if v["facts"]:
        parts.append(element_words(it))
    else:
        e = it["el"]
        parts.append("Element: <%s>%s." % (e["tag"], ", role %s" % e["role"] if e.get("role") else ""))
    state = "\n".join(parts)
    questions = {
        "verdict": {"type": "choice", "instructions": VERDICT_Q, "criteria": CRITERIA[v["prompt"]]},
        "family": {"type": "choice", "instructions": FAMILY_Q, "criteria": FAMILY_CRITERIA},
    }
    body = {"model": v["model"], "state": state, "questions": questions}
    if v["image"]:
        raw = open(it["img"], "rb").read()
        if v["image"] == "outline":
            from PIL import Image, ImageDraw
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            x, y, w, h = it["crop"]["inCrop"]
            ImageDraw.Draw(im).rectangle([x - 2, y - 2, x + w + 1, y + h + 1], outline=(255, 0, 255), width=2)
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=90)
            raw = buf.getvalue()
        body["image_b64"] = base64.b64encode(raw).decode()
        body["content_type"] = "image/jpeg"
    return body


# ---------------------------------------------------------------- calling the worker


def post(url, key, body, tries=7):
    data = json.dumps(body).encode()
    err = None
    for k in range(tries):
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers={"content-type": "application/json", "x-eval-key": key,
                                              "user-agent": "genclass-clef-eval/1"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                out = json.loads(r.read())
                out["wall_ms"] = round((time.time() - t0) * 1000)
                return out
        except urllib.error.HTTPError as e:
            msg = e.read()[:300].decode(errors="replace")
            err = "HTTP %d %s" % (e.code, msg)
            if e.code in (400, 403, 404, 413):
                break
        except Exception as e:  # network errors, timeouts
            err = repr(e)[:300]
        time.sleep(min(60, 2 ** k + random.random()))
    return {"error": err}


def cmd_run(a):
    url = os.environ["CLEF_EVAL_URL"]
    key = open(os.environ["CLEF_EVAL_KEY_FILE"]).read().strip()
    v = VARIANTS[a.variant]
    items = [it for it in load_items(a.work) if a.split == "all" or it["split"] == a.split]
    if a.limit:
        items = items[: a.limit]
    d = os.path.join(a.work, "runs", a.variant)
    os.makedirs(d, exist_ok=True)
    todo = [it for it in items if not os.path.exists(os.path.join(d, it["id"] + ".json"))]
    print("%s: %d items, %d to run" % (a.variant, len(items), len(todo)), flush=True)
    lock = threading.Lock()
    done = [0, 0]

    def one(it):
        out = post(url, key, build_request(it, v))
        if "error" not in out:
            with open(os.path.join(d, it["id"] + ".json"), "w") as fh:
                json.dump(out, fh)
        with lock:
            done[0] += 1
            if "error" in out:
                done[1] += 1
                print("error %s: %s" % (it["id"], out["error"]), file=sys.stderr, flush=True)
            if done[0] % 100 == 0:
                print("%d/%d (%d errors)" % (done[0], len(todo), done[1]), flush=True)

    with ThreadPoolExecutor(a.concurrency) as ex:
        for f in as_completed([ex.submit(one, it) for it in todo]):
            f.result()
    print("done %d, errors %d" % (done[0], done[1]))


# ---------------------------------------------------------------- metrics


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
    # Mann-Whitney U with average ranks for ties
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


def summary(y, s):
    y = np.asarray(y)
    if (y == 1).sum() == 0:
        return None
    r = lambda v: None if v is None else round(v, 3)
    return {"n": int(len(y)), "real": int((y == 1).sum()), "ap": r(ap(y, s)), "rocAuc": r(auc(y, s)),
            "precisionAtRecall0.5": r(p_at_r(y, s, 0.5)), "recallAtPrecision0.6": r(r_at_p(y, s, 0.6)),
            "recallAtPrecision0.8": r(r_at_p(y, s, 0.8))}


def bootstrap(items, score, stat, n=1000, seed=7):
    """Host-level bootstrap 95% interval of stat(y, s)."""
    groups = {}
    for k, it in enumerate(items):
        groups.setdefault(it["g"], []).append(k)
    keys = list(groups)
    rng = np.random.default_rng(seed)
    y = np.array([it["y"] for it in items])
    s = np.array(score)
    vals = []
    for _ in range(n):
        pick = rng.integers(0, len(keys), len(keys))
        idx = np.concatenate([groups[keys[p]] for p in pick])
        if y[idx].sum() == 0:
            continue
        v = stat(y[idx], s[idx])
        if v is not None:
            vals.append(v)
    if not vals:
        return None
    return [round(float(np.percentile(vals, 2.5)), 3), round(float(np.percentile(vals, 97.5)), 3)]


def load_answers(work, variant, items):
    d = os.path.join(work, "runs", variant)
    out = {}
    if not os.path.isdir(d):
        return out
    for it in items:
        p = os.path.join(d, it["id"] + ".json")
        if os.path.exists(p):
            out[it["id"]] = json.load(open(p))
    return out


def any_problem(ans):
    """1 - P(none) on the family question: the primary score (chosen on dev, see README)."""
    return 1.0 - ans["answers"]["family"]["probabilities"].get("none", 0.0)


def not_fine(ans):
    """1 - P(fine) on the verdict question."""
    return 1.0 - ans["answers"]["verdict"]["probabilities"].get("fine", 0.0)


SCORES = {"anyProblem": any_problem, "notFine": not_fine}
PRIMARY_SCORE = "anyProblem"

# the v1 rules that look for each labelling family (for the per-family rule baseline)
FAMILY_RULES = {"media": {"image-broken", "image-distorted", "media-failed", "text-placeholder"},
                "overflow": {"page-overflow-x"}, "occlusion": {"control-unreachable", "click-blocked"},
                "dark": {"text-invisible", "css-var-undefined"}, "text": {"text-invisible", "css-var-undefined", "font-failed"},
                "leaks": {"text-template-leak", "text-placeholder"}}
# what each paired comparison measures: facts vs no facts, image vs no image, Clef vs Clef-flash
PAIRS = [("clef-imgonly-p2", "clef-img-p3"), ("clef-img-p3", "clef-text-p3"), ("flash-img-p3", "flash-text-p3"),
         ("clef-img-p3", "flash-img-p3")]


def threshold_for_recall(y, s, r0):
    P, R, T = curve(y, s)
    ok = np.where(R >= r0 - 1e-9)[0]
    return float(T[ok[0]]) if len(ok) else float(T[-1])


def threshold_best_f1(y, s):
    P, R, T = curve(y, s)
    f1 = 2 * P * R / np.maximum(1e-9, P + R)
    return float(T[int(np.argmax(f1))])


def cmd_report(a):
    items = load_items(a.work)
    by = {"dev": [it for it in items if it["split"] == "dev"], "report": [it for it in items if it["split"] == "report"]}
    fam_counts = {}
    for it in by["report"]:
        if it["y"]:
            fam_counts[it["family"]] = fam_counts.get(it["family"], 0) + 1
    big_fams = sorted([f for f, c in fam_counts.items() if c >= 15], key=lambda f: -fam_counts[f])
    res = {"split": {k: {"n": len(v), "real": sum(it["y"] for it in v), "hosts": len({it["g"] for it in v})} for k, v in by.items()},
           "reportRealByFamily": fam_counts, "familiesReported": big_fams, "primaryScore": PRIMARY_SCORE,
           "baselines": {}, "variants": {}}

    def scored_block(sub, score, dev_sub=None, dev_score=None):
        y = [it["y"] for it in sub]
        blk = {"all": summary(y, score)}
        blk["all"]["apCI"] = bootstrap(sub, score, ap)
        blk["all"]["pAtR05CI"] = bootstrap(sub, score, lambda yy, ss: p_at_r(yy, ss, 0.5))
        blk["curve"] = {"%.1f" % r0: (None if p_at_r(y, score, r0) is None else round(p_at_r(y, score, r0), 3))
                        for r0 in (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)}
        # the low end, for labelling "fine": the lowest-scored share of the crops and the reals among them
        o = np.argsort(np.asarray(score, float), kind="mergesort")
        blk["lowEnd"] = {}
        for share in (0.5, 0.7, 0.8, 0.9):
            k = o[: int(len(o) * share)]
            blk["lowEnd"]["%.1f" % share] = {"crops": int(len(k)), "real": int(sum(y[i] for i in k)),
                                             "realShareOfAllReal": round(sum(y[i] for i in k) / max(1, sum(y)), 3)}
        blk["byFamily"] = {}
        for f in big_fams:
            k = [i for i, it in enumerate(sub) if it["y"] == 0 or it["family"] == f]
            blk["byFamily"][f] = summary([sub[i]["y"] for i in k], [score[i] for i in k])
        blk["byStratum"] = {}
        for st in ("rules", "gbt", "random"):
            k = [i for i, it in enumerate(sub) if it["stratum"] == st]
            blk["byStratum"][st] = summary([sub[i]["y"] for i in k], [score[i] for i in k])
        if dev_sub is not None:
            dy = [it["y"] for it in dev_sub]
            t50 = threshold_for_recall(dy, dev_score, 0.5)
            tf1 = threshold_best_f1(dy, dev_score)
            blk["devThresholds"] = {"recall0.5OnDev": at_threshold(y, score, t50), "bestF1OnDev": at_threshold(y, score, tf1)}
            # as a filter on the rule-flagged candidates (the scanner's use): recall over every real in the split
            fl = [i for i, it in enumerate(sub) if it["rules"]]
            ny = sum(y)
            for name, t in (("recall0.5OnDev", t50), ("bestF1OnDev", tf1)):
                kept = [i for i in fl if score[i] >= t]
                tp = sum(sub[i]["y"] for i in kept)
                blk["devThresholds"][name]["onRuleFlagged"] = {"flagged": len(kept), "tp": tp, "fp": len(kept) - tp,
                                                               "precision": round(tp / max(1, len(kept)), 3),
                                                               "recall": round(tp / max(1, ny), 3)}
                by_rule = {}
                for i in fl:
                    for r in sub[i]["rules"]:
                        b = by_rule.setdefault(r, {"flagged": 0, "real": 0, "kept": 0, "keptReal": 0})
                        b["flagged"] += 1
                        b["real"] += sub[i]["y"]
                        if score[i] >= t:
                            b["kept"] += 1
                            b["keptReal"] += sub[i]["y"]
                blk["devThresholds"][name]["byRule"] = by_rule
        return blk

    # baselines
    for name, sub in by.items():
        y = [it["y"] for it in sub]
        flagged = [i for i, it in enumerate(sub) if it["rules"]]
        tp = sum(sub[i]["y"] for i in flagged)
        rb = {"flagged": len(flagged), "tp": tp, "precision": round(tp / max(1, len(flagged)), 3), "recall": round(tp / max(1, sum(y)), 3),
              "byStratum": {}, "byFamily": {}}
        for st in ("rules", "gbt", "random"):
            k = [i for i, it in enumerate(sub) if it["stratum"] == st]
            fk = [i for i in k if sub[i]["rules"]]
            t = sum(sub[i]["y"] for i in fk)
            rb["byStratum"][st] = {"n": len(k), "real": sum(sub[i]["y"] for i in k), "flagged": len(fk), "tp": t}
        for f in big_fams:
            k = [i for i, it in enumerate(sub) if it["y"] == 0 or it["family"] == f]
            fk = [i for i in k if sub[i]["rules"]]
            t = sum(sub[i]["y"] for i in fk)
            rb["byFamily"][f] = {"flagged": len(fk), "tp": t, "precision": round(t / max(1, len(fk)), 3),
                                 "recall": round(t / max(1, sum(sub[i]["y"] for i in k)), 3)}
        res["baselines"].setdefault("rulesV1", {})[name] = rb
    # each family against only the rules that look for it (the reals of that family against every "not")
    own = {}
    for f in big_fams:
        rs = FAMILY_RULES.get(f, set())
        k = [it for it in by["report"] if it["y"] == 0 or it["family"] == f]
        fl = [it for it in k if set(it["rules"]) & rs]
        tp = sum(it["y"] for it in fl)
        own[f] = {"rules": sorted(rs), "flagged": len(fl), "tp": tp, "precision": round(tp / max(1, len(fl)), 3),
                  "recall": round(tp / max(1, sum(it["y"] for it in k)), 3)}
    res["baselines"]["rulesV1OwnFamily"] = {"report": own}
    gs = {k: [it["gbt"] if it["gbt"] is not None else 0.0 for it in v] for k, v in by.items()}
    res["baselines"]["gbtSmallV1"] = {"report": scored_block(by["report"], gs["report"], by["dev"], gs["dev"])}
    rules_recall = res["baselines"]["rulesV1"]["report"]["recall"]

    # Clef variants, under both scores
    for vname in VARIANTS:
        ans = {k: load_answers(a.work, vname, v) for k, v in by.items()}
        if not ans["report"] and not ans["dev"]:
            continue
        entry = {"config": VARIANTS[vname], "answered": {k: len(v) for k, v in ans.items()}}
        full = {k: len(ans[k]) >= len(by[k]) * 0.98 for k in by}
        for sname, fn in SCORES.items():
            blk = {}
            if full["dev"]:
                dsub = [it for it in by["dev"] if it["id"] in ans["dev"]]
                ds = [fn(ans["dev"][it["id"]]) for it in dsub]
                blk["dev"] = summary([it["y"] for it in dsub], ds)
            if full["report"]:
                sub = [it for it in by["report"] if it["id"] in ans["report"]]
                s_ = [fn(ans["report"][it["id"]]) for it in sub]
                blk["report"] = scored_block(sub, s_, dsub if full["dev"] else None, ds if full["dev"] else None)
            entry.setdefault("scores", {})[sname] = blk
        if full["report"]:
            sub = [it for it in by["report"] if it["id"] in ans["report"]]
            fr = [it for it in sub if it["y"]]
            hit = sum(1 for it in fr if ans["report"][it["id"]]["answers"]["family"]["choice"] == it["family"])
            entry["familyTop1OnReal"] = {"n": len(fr), "correct": hit, "accuracy": round(hit / max(1, len(fr)), 3)}
            # per family with the family's own probability as the score (reals of that family against every "not")
            entry["byFamilyOwnProbability"] = {}
            for f in big_fams:
                k = [it for it in sub if it["y"] == 0 or it["family"] == f]
                yk = [it["y"] for it in k]
                own_s = [ans["report"][it["id"]]["answers"]["family"]["probabilities"].get(f, 0.0) for it in k]
                any_s = [any_problem(ans["report"][it["id"]]) for it in k]
                entry["byFamilyOwnProbability"][f] = summary(yk, own_s)
                r0 = own[f]["recall"]
                entry["byFamilyOwnProbability"][f]["atOwnRulesRecall"] = {
                    "recall": r0, "precisionOwnProbability": round(p_at_r(yk, own_s, r0) or 0, 3),
                    "precisionAnyProblem": round(p_at_r(yk, any_s, r0) or 0, 3)}
            y_all = [it["y"] for it in sub]
            entry["atRulesRecall"] = {"recall": rules_recall, "precisionAnyProblem": round(
                p_at_r(y_all, [any_problem(ans["report"][it["id"]]) for it in sub], rules_recall) or 0, 3)}
            entry["_scores"] = {it["id"]: any_problem(ans["report"][it["id"]]) for it in sub}
            verdicts = {}
            for it in sub:
                c = ans["report"][it["id"]]["answers"]["verdict"]["choice"]
                side = verdicts.setdefault("real" if it["y"] else "not", {})
                side[c] = side.get(c, 0) + 1
            entry["topVerdictChoice"] = verdicts
        for k in ("dev", "report"):
            allans = list(ans[k].values())
            if not allans:
                continue
            ms = np.array([x["ms"] for x in allans])
            wall = np.array([x["wall_ms"] for x in allans])
            tok = np.array([x["usage"]["input_tokens"] for x in allans])
            price = PRICE_PER_M[VARIANTS[vname]["model"]]
            entry.setdefault("latencyTokens", {})[k] = {
                "calls": len(allans), "serverMsMedian": int(np.median(ms)), "serverMsP95": int(np.percentile(ms, 95)),
                "wallMsMedian": int(np.median(wall)), "wallMsP95": int(np.percentile(wall, 95)),
                "inputTokensMedian": int(np.median(tok)), "inputTokensMean": round(float(tok.mean()), 1),
                "inputTokensP95": int(np.percentile(tok, 95)),
                "usdPer1000": round(float(tok.mean()) * 1000 * price / 1e6, 4),
                "usdPerScan40": round(float(tok.mean()) * 40 * price / 1e6, 5)}
        res["variants"][vname] = entry
    # paired, host-level bootstrap of AP differences on the report side (primary score)
    res["pairedApDifferences"] = {}
    rep = by["report"]
    for x, z in PAIRS:
        vx, vz = res["variants"].get(x, {}), res["variants"].get(z, {})
        if "_scores" not in vx or "_scores" not in vz:
            continue
        sx = np.array([vx["_scores"][it["id"]] for it in rep])
        sz = np.array([vz["_scores"][it["id"]] for it in rep])
        diff = bootstrap(rep, list(range(len(rep))), lambda yy, ii: ap(yy, sx[ii.astype(int)]) - ap(yy, sz[ii.astype(int)]), n=2000)
        y = np.array([it["y"] for it in rep])
        res["pairedApDifferences"]["%s minus %s" % (x, z)] = {"diff": round(ap(y, sx) - ap(y, sz), 3), "ci95": diff}
    for v in res["variants"].values():
        v.pop("_scores", None)
    res["latencyRuns"] = {}
    for vname in VARIANTS:
        p = os.path.join(a.work, "latency-%s.json" % vname)
        if os.path.exists(p):
            res["latencyRuns"][vname] = json.load(open(p))
    with open(a.out, "w") as fh:
        json.dump(res, fh, indent=1)
    for k, v in res["variants"].items():
        r = v["scores"][PRIMARY_SCORE].get("report")
        print(k, json.dumps(r["all"] if r else v["scores"][PRIMARY_SCORE].get("dev")))


def cmd_latency(a):
    """Unloaded latency (one call at a time) and the wall time of a 40-candidate scan sent at once."""
    url = os.environ["CLEF_EVAL_URL"]
    key = open(os.environ["CLEF_EVAL_KEY_FILE"]).read().strip()
    v = VARIANTS[a.variant]
    items = [it for it in load_items(a.work) if it["split"] == "report"]
    rng = random.Random(11)
    rng.shuffle(items)
    seq = []
    for it in items[: a.n]:
        out = post(url, key, build_request(it, v))
        if "error" not in out:
            seq.append((out["ms"], out["wall_ms"]))
    scans = []
    for b in range(a.scans):
        batch = items[a.n + b * 40: a.n + (b + 1) * 40]
        bodies = [build_request(it, v) for it in batch]
        t0 = time.time()
        with ThreadPoolExecutor(40) as ex:
            outs = list(ex.map(lambda body: post(url, key, body), bodies))
        scans.append({"wallMs": round((time.time() - t0) * 1000), "errors": sum(1 for o in outs if "error" in o),
                      "serverMsMax": max((o.get("ms", 0) for o in outs), default=0)})
    ms = np.array([x[0] for x in seq])
    wall = np.array([x[1] for x in seq])
    res = {"variant": a.variant, "sequentialCalls": len(seq), "serverMsMedian": int(np.median(ms)), "serverMsP95": int(np.percentile(ms, 95)),
           "wallMsMedian": int(np.median(wall)), "wallMsP95": int(np.percentile(wall, 95)), "scans40": scans}
    path = os.path.join(a.work, "latency-%s.json" % a.variant)
    with open(path, "w") as fh:
        json.dump(res, fh, indent=1)
    print(json.dumps(res))


def cmd_show(a):
    items = {it["id"]: it for it in load_items(a.work)}
    it = items[a.id]
    print(json.dumps({k: v for k, v in build_request(it, VARIANTS[a.variant]).items() if k != "image_b64"}, indent=1))


def main():
    ap_ = argparse.ArgumentParser()
    sp = ap_.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("prepare")
    p.add_argument("--data", required=True)
    p.add_argument("--work", required=True)
    p = sp.add_parser("run")
    p.add_argument("--work", required=True)
    p.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    p.add_argument("--split", default="dev", choices=["dev", "report", "all"])
    p.add_argument("--concurrency", type=int, default=6)
    p.add_argument("--limit", type=int, default=0)
    p = sp.add_parser("report")
    p.add_argument("--work", required=True)
    p.add_argument("--out", required=True)
    p = sp.add_parser("latency")
    p.add_argument("--work", required=True)
    p.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    p.add_argument("--n", type=int, default=100)
    p.add_argument("--scans", type=int, default=5)
    p = sp.add_parser("show")
    p.add_argument("--work", required=True)
    p.add_argument("--variant", required=True, choices=sorted(VARIANTS))
    p.add_argument("--id", required=True)
    a = ap_.parse_args()
    {"prepare": cmd_prepare, "run": cmd_run, "report": cmd_report, "latency": cmd_latency, "show": cmd_show}[a.cmd](a)


if __name__ == "__main__":
    main()
