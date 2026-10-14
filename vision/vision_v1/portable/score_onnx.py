#!/usr/bin/env python3
# Self-contained scorer for the exported GenClass Vision v1 model: needs only numpy, Pillow and onnxruntime and the
# files next to it (model.onnx or model.int8.onnx, spec.json). The crop preparation and the measured facts below are
# copied verbatim from vision/vision_v1/common.py (num, letterbox, TEXT_TAGS, FACT_NAMES, facts), so a port to another
# language has one reference to match.
#
#   score_onnx.py --model model.onnx --items items.jsonl --out scores.jsonl
#
# items.jsonl: one JSON object per crop with `img` (a crop file at CSS-pixel resolution: the element box plus 24 px,
# clipped to the viewport), `el` (the element's row from vision/src/extract.js), `page` (its view's page record),
# `device` (desktop or phone), `scheme` (light or dark), `kids` (child rows, at most 12) and `crop`
# ({size: [w, h], inCrop: [x, y, w, h]}). Output: one line per item with `any` and `family` (11 probabilities).

import argparse
import json
import os

import numpy as np

IN_W, IN_H = 224, 128
MAX_UPSCALE = 2.0
LETTERBOX_FILL = (128, 128, 128)


def num(v, d=0.0):
    return v if isinstance(v, (int, float)) and v == v else d



def letterbox(img, W=IN_W, H=IN_H, max_up=MAX_UPSCALE):
    """Fit into W x H keeping the aspect ratio (upscale at most max_up), centred on grey. Returns uint8 HxWx3 and the
    placement (scale, dx, dy) so a box inside the crop can be mapped onto the input."""
    from PIL import Image
    w, h = img.size
    s = min(W / w, H / h, max_up)
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    r = img.resize((nw, nh), Image.BICUBIC if s > 1 else Image.BILINEAR)
    canvas = Image.new("RGB", (W, H), LETTERBOX_FILL)
    dx, dy = (W - nw) // 2, (H - nh) // 2
    canvas.paste(r, (dx, dy))
    return np.asarray(canvas, dtype=np.uint8), (s, dx, dy)



TEXT_TAGS = {"p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "li", "label", "small", "strong", "em", "b", "i", "td",
             "th", "dt", "dd", "blockquote", "figcaption", "code", "pre"}
FACT_NAMES = [
    "phone", "dark", "pageSideways", "pageSidewaysPx", "appDark", "pageFailedLoads",
    "x/vw", "right/vw", "y/vh", "bottom/vh", "logW", "logH", "inv",
    "inCropX", "inCropY", "inCropW", "inCropH",
    "interactive", "pointer", "pointerEventsNone", "disabled", "fixedOrSticky", "absolute",
    "hasOwnText", "logOwnText", "logAllText", "fontSize", "contrast", "contrastMissing", "bgKnown",
    "paintContrast", "paintContrastMissing", "effOpacity",
    "hitSelf", "hitOther", "hitAncestor", "hitNone",
    "tagImg", "tagSvg", "tagMedia", "tagButton", "tagA", "tagField", "tagText", "tagOther",
    "imgBroken", "imgDistortion", "imgNoNaturalSize", "imgNoAlt",
    "scrollsX", "scrollsY", "overflowHidden", "clipAncestors", "clipVisible", "textSpill",
    "leakPattern", "undefinedVar", "zIndex", "transform", "filter", "animation", "bgImage", "logKids", "clipPath",
]


def facts(it):
    """The measured facts of one item (element row `el`, page record `page`, crop geometry) as float32."""
    e, p = it["el"], it["page"] or {}
    vw, vh = num(p.get("vw"), 1366) or 1366, num(p.get("vh"), 768) or 768
    sw, cw = num(p.get("scrollW")), num(p.get("clientW"))
    res = p.get("res") or {}
    x, y, w, h = num(e.get("x")), num(e.get("y")), num(e.get("w")), num(e.get("h"))
    cs, ic = it["crop"]["size"], it["crop"]["inCrop"]
    cr, scr = e.get("cr"), e.get("scr")
    tag = e.get("tag", "")
    hs = e.get("hs")
    f = [
        1.0 if it["device"] == "phone" else 0.0, 1.0 if it["scheme"] == "dark" else 0.0,
        1.0 if sw > cw + 1 else 0.0, np.log1p(max(0.0, sw - cw)) / 7, 1.0 if p.get("appDark") else 0.0,
        min(1.0, (num(res.get("imgFailed")) + num(res.get("cssFailed")) + num(res.get("fontFailed"))) / 3),
        x / vw, (x + w) / vw, y / vh, (y + h) / vh, np.log1p(max(0, w)) / 8, np.log1p(max(0, h)) / 8, num(e.get("inv")),
        num(ic[0]) / max(1, cs[0]), num(ic[1]) / max(1, cs[1]), num(ic[2]) / max(1, cs[0]), num(ic[3]) / max(1, cs[1]),
        1.0 if e.get("ia") else 0.0, 1.0 if e.get("cur") else 0.0, 1.0 if e.get("pen") else 0.0, 1.0 if e.get("dis") else 0.0,
        1.0 if e.get("pos") in ("f", "s") else 0.0, 1.0 if e.get("pos") == "a" else 0.0,
        1.0 if e.get("tl") else 0.0, np.log1p(num(e.get("tl"))) / 7, np.log1p(num(e.get("tt"))) / 8, num(e.get("fs"), 16) / 32,
        np.log(max(1.0, num(cr, 1))) / np.log(21) if isinstance(cr, (int, float)) else 0.0, 0.0 if isinstance(cr, (int, float)) else 1.0,
        1.0 if e.get("ebs", 0) == 0 else 0.0,
        np.log(max(1.0, num(scr, 1))) / np.log(21) if isinstance(scr, (int, float)) else 0.0, 0.0 if isinstance(scr, (int, float)) else 1.0,
        num(e.get("eop"), 1) * num(e.get("op"), 1),
        num(hs, 0) / 5, num(e.get("ho")) / 5, num(e.get("ha")) / 5, num(e.get("hn")) / 5,
        1.0 if tag == "img" else 0.0, 1.0 if tag in ("svg", "path", "use", "g") else 0.0,
        1.0 if tag in ("video", "canvas", "iframe", "picture", "object", "embed") else 0.0,
        1.0 if tag == "button" else 0.0, 1.0 if tag == "a" else 0.0, 1.0 if tag in ("input", "select", "textarea") else 0.0,
        1.0 if tag in TEXT_TAGS else 0.0, 0.0,
        1.0 if tag == "img" and e.get("cmp") and not e.get("iok") else 0.0, min(1.0, num(e.get("dist"))),
        1.0 if tag == "img" and not num(e.get("nw")) else 0.0, 1.0 if tag == "img" and e.get("alt", -1) == -1 else 0.0,
        1.0 if e.get("sw") is not None and num(e.get("sw")) > num(e.get("cw")) + 1 else 0.0,
        1.0 if e.get("sh") is not None and num(e.get("sh")) > num(e.get("ch")) + 1 else 0.0,
        1.0 if e.get("ox") in ("h", "c") or e.get("oy") in ("h", "c") else 0.0,
        min(1.0, num(e.get("nca")) / 3), num(e.get("cvis"), 1), min(1.0, num(e.get("tspill")) / 20),
        1.0 if e.get("lk") else 0.0, 1.0 if (e.get("vu") or e.get("vi")) else 0.0,
        1.0 if e.get("z") is not None else 0.0, 1.0 if e.get("tf") else 0.0, 1.0 if e.get("flt") else 0.0,
        1.0 if e.get("an") else 0.0, 1.0 if e.get("bgi") else 0.0, np.log1p(num(it.get("kids"))) / 4,
        1.0 if (e.get("clip") or e.get("cpath")) else 0.0,
    ]
    assert len(f) == len(FACT_NAMES)
    k = FACT_NAMES.index("tagOther")
    f[k] = 1.0 if sum(f[k - 7:k]) == 0 else 0.0
    a = np.asarray(f, dtype=np.float32)
    return np.clip(np.nan_to_num(a, nan=0.0, posinf=3.0, neginf=-3.0), -3, 3)


assert len(FACT_NAMES) == 64


def main():
    import onnxruntime as ort
    from PIL import Image
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--items", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--batch", type=int, default=64)
    a = ap.parse_args()
    spec = json.load(open(os.path.join(os.path.dirname(os.path.abspath(a.model)), "spec.json")))
    assert spec["inputs"]["facts"]["names"] == FACT_NAMES, "facts out of step with spec.json"
    so = ort.SessionOptions()
    so.intra_op_num_threads = 4
    sess = ort.InferenceSession(a.model, so, providers=["CPUExecutionProvider"])
    items = [json.loads(l) for l in open(a.items)]
    with open(a.out, "w") as out:
        for s in range(0, len(items), a.batch):
            chunk = items[s: s + a.batch]
            x = np.stack([letterbox(Image.open(it["img"]).convert("RGB"))[0] for it in chunk]).astype(np.float32).transpose(0, 3, 1, 2)
            f = np.stack([facts(it) for it in chunk]).astype(np.float32)
            fam, anyp = sess.run(None, {"image": np.ascontiguousarray(x), "facts": f})
            for it, fa, an in zip(chunk, fam, anyp):
                out.write(json.dumps({"id": it.get("id"), "any": float(an), "family": [float(v) for v in fa]}) + "\n")


if __name__ == "__main__":
    main()
