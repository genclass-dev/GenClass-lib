# Shared pieces of GenClass Vision v2, copied from vision/vision_v1/common.py (branch wave2/vision-v1, 48617fd): paths,
# the Clef evaluation's split, crop geometry, image preparation and the 64 measured facts the student sees next to the
# image. Only the paths are new: Vision v2 reads Vision v1's index, packs, Clef answers and frozen test set (VISION_V1)
# and writes everything of its own under VISION_V2_OUT.
#
# Invariants:
# - Training uses only hosts of the round-2 train split (trainset/views.jsonl.gz, split "train", not a near-duplicate),
#   minus the frozen test set's held-out hosts and minus the hosts of the fresh dev set (devset.py).
# - Hosts appear only in node-side inputs. Files this package writes carry crop ids, view ids and salted host hashes;
#   anything that leaves the node carries random ids (secrets.token_hex) only.
# - Every image the student sees is brought to CSS-pixel resolution first (the crawl's viewport shots are stored at 0.5x
#   on desktop and 0.75x on phone), so one input pixel means the same thing whatever the source.

import hashlib
import io
import os

import numpy as np

B = os.path.expanduser(os.environ.get("VISION_V2", "~/vision-out/v2"))  # the v2 crawl, training set and labels
V1 = os.path.expanduser(os.environ.get("VISION_V1", "~/vision-out/vision-v1"))  # Vision v1: index, packs, Clef, test
OUT = os.path.expanduser(os.environ.get("VISION_V2_OUT", "~/vision-out/vision-v2"))  # everything this package writes

SHOT_SCALE = {"desktop": 0.5, "phone": 0.75}  # crawl.mjs DEVICES[device].shotScale
PAD = 24  # context around the element box, CSS px (candidates.mjs cropRect)
# student input, letterboxed: 224 x 128 unless VV1_INPUT says otherwise (e.g. "320x192"); each size has its own pack
IN_W, IN_H = (int(v) for v in os.environ.get("VV1_INPUT", "224x128").split("x"))
# Vision v1's 224 x 128 pack is reused as is; other sizes are packed under OUT (pack.py)
PACK_DIR = os.path.join(V1, "pack") if (IN_W, IN_H) == (224, 128) else os.path.join(OUT, "pack-%dx%d" % (IN_W, IN_H))
MAX_UPSCALE = 2.0
LETTERBOX_FILL = (128, 128, 128)

# the Clef evaluation's split of the labelled crops (vision/clef/eval.py): 20% of hosts dev, 80% report
CLEF_SALT = "clef-eval-1"
CLEF_DEV_SHARE = 0.2

# Clef's family question (vision/clef/eval.py FAMILY_CRITERIA), in a fixed order: the student's family head
FAMILIES = ["none", "text", "dark", "overflow", "responsive", "occlusion", "media", "leaks", "blank", "controls", "other"]
VERDICTS = ["fine", "unreadable_text", "hidden_control", "broken_image", "cut_off", "overlap", "leak", "blank"]
# injected-fault families (research/visual/injectors.json) on the family head
INJ_FAMILY = {"text": "text", "dark": "dark", "overflow": "overflow", "responsive": "responsive", "occlusion": "occlusion",
              "media": "media", "leaks": "leaks", "blank": "blank", "controls": "controls", "design": "other",
              "styles": "other", "other": "other", "motion": "other"}
# the fault family's likely verdict, for the verdict head of injected rows
INJ_VERDICT = {"text": "unreadable_text", "dark": "unreadable_text", "overflow": "cut_off", "responsive": "cut_off",
               "occlusion": "overlap", "media": "broken_image", "leaks": "leak", "blank": "blank",
               "controls": "hidden_control"}


def clef_host_group(host):
    return hashlib.sha256((CLEF_SALT + ":" + host).encode()).hexdigest()[:12]


def clef_is_dev(host):
    h = int(hashlib.sha256((CLEF_SALT + ":split:" + host).encode()).hexdigest()[:8], 16)
    return h / 2**32 < CLEF_DEV_SHARE


def host_hash(host, salt="vision-v1"):
    return hashlib.sha256((salt + ":" + host).encode()).hexdigest()[:12]


def crop_id(kind, vid, i):
    """Node-only id of a crop this package cuts. It is derived from the view id, which derives from the host, so it
    must never leave the node or enter git (committed files hold aggregates only; the test set uses random ids)."""
    return kind[0] + hashlib.sha1(("v1|%s|%s|%s" % (kind, vid, i)).encode()).hexdigest()[:12]


def num(v, d=0.0):
    return v if isinstance(v, (int, float)) and v == v else d


def crop_rect(row, vw, vh, pad=PAD):
    """candidates.mjs cropRect: the element box plus pad, clipped to the viewport, in CSS px; None when under 4 px."""
    x0 = max(0, int(np.floor(num(row.get("x")) - pad)))
    y0 = max(0, int(np.floor(num(row.get("y")) - pad)))
    x1 = min(vw, int(np.ceil(num(row.get("x")) + num(row.get("w")) + pad)))
    y1 = min(vh, int(np.ceil(num(row.get("y")) + num(row.get("h")) + pad)))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    return [x0, y0, x1, y1]


def eligible(row):
    """candidates.mjs eligible(): a box of at least 4 x 4 px, visible, partly in the viewport, not html or body."""
    return (isinstance(row.get("x"), (int, float)) and row.get("vis") == 1 and num(row.get("inv")) > 0
            and num(row.get("w")) >= 4 and num(row.get("h")) >= 4 and row.get("tag") not in ("html", "body"))


# ---------------------------------------------------------------- images


def cut_from_shot(shot, rect, vw):
    """Cut a CSS-px rect out of a viewport shot stored at a reduced scale and bring it back to CSS px (bicubic)."""
    from PIL import Image
    k = shot.width / vw
    x0, y0, x1, y1 = rect
    box = (int(round(x0 * k)), int(round(y0 * k)), int(round(x0 * k)) + max(1, int(round((x1 - x0) * k))),
           int(round(y0 * k)) + max(1, int(round((y1 - y0) * k))))
    c = shot.crop(box)
    return c.resize((x1 - x0, y1 - y0), Image.BICUBIC)


def degrade(img, device, quality=55):
    """What a full-resolution crop looks like after the crawl's shot pipeline: down to the shot scale, JPEG at the
    shot quality, back up to CSS px. Used on the training side so resolution never tells sources apart."""
    from PIL import Image
    s = SHOT_SCALE[device]
    w, h = img.size
    small = img.resize((max(1, int(round(w * s))), max(1, int(round(h * s)))), Image.BILINEAR)
    buf = io.BytesIO()
    small.save(buf, "JPEG", quality=quality)
    buf.seek(0)
    return Image.open(buf).convert("RGB").resize((w, h), Image.BICUBIC)


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


# ---------------------------------------------------------------- measured facts for the student

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
