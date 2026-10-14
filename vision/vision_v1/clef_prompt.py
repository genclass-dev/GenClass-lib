# The Clef prompt of vision/clef/eval.py (branch wave2/clef-eval, commit 3be5c2f), copied verbatim from its
# "the prompt" and "questions" sections so the natural crops are asked exactly as the evaluation asked the
# labelled ones. Only this header and the imports are new; parity.py checks that the requests match byte for byte.

import base64
import io

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

