"""Shared loading, model inputs and the measured-threshold rules for the visual-bug classifiers.

The training set is the one src/build_set.mjs writes (X-<split>.f32, meta-<split>.jsonl.gz, views.jsonl.gz,
schema.json). Splits are by host after near-duplicate removal; `val` is the dev split.
"""

import gzip
import json
import os
import time

import numpy as np

# columns that record how a view was made rather than what it shows. pRound and pFontsLoaded are no longer in the v2
# matrices (build_set.mjs REMOVED_V1); pVw and pVh stay in the matrix for the rules and the relative box below, and
# pDark (the emulated scheme) stays out of the inputs as in v1. Names missing from a schema are ignored.
DROP = {"pRound", "pFontsLoaded", "pVw", "pVh", "pDark"}
# provenance gate (train/provenance.py): no model is trained unless a classifier cannot tell clean elements of injected
# views from elements of natural views better than this ROC AUC
PROVENANCE_MAX_AUC = 0.55
Y_CODES = {"nat": 0, "clean": 1, "control": 2, "fault": 3}
FAMILIES = ["blank", "controls", "dark", "design", "leaks", "media", "motion", "occlusion", "other", "overflow",
            "responsive", "styles", "text"]
DERIVED = ["xr", "rr", "yr", "br", "wr", "ar"]  # box relative to the viewport (the raw viewport size is dropped)

T0 = time.time()


def log(m):
    print(f"[{time.time() - T0:.0f}s] {m}", flush=True)


class Split:
    """One split: X (float32, F columns), y codes, view index, families of fault rows, pixel verdicts, nat bits."""

    def __init__(self, set_dir, name, schema):
        F = schema["F"]
        self.name = name
        self.X = np.fromfile(os.path.join(set_dir, f"X-{name}.f32"), dtype=np.float32).reshape(-1, F)
        n = self.X.shape[0]
        self.y = np.zeros(n, np.int8)
        self.v = np.zeros(n, np.int32)
        self.i = np.zeros(n, np.int32)
        self.nb = np.zeros(n, np.int16)  # natural-signal bits (schema natBits)
        self.pv = np.zeros(n, np.int8)  # 0 none, 1 seen, 2 unseen, 3 out
        self.noisy = np.zeros(n, np.int8)
        self.fam = np.zeros((n, len(FAMILIES)), bool)
        self.recipes = {}  # row -> recipe ids (fault rows only)
        fi = {f: k for k, f in enumerate(FAMILIES)}
        pvc = {"seen": 1, "unseen": 2, "out": 3}
        with gzip.open(os.path.join(set_dir, f"meta-{name}.jsonl.gz"), "rt") as fh:
            for r, line in enumerate(fh):
                m = json.loads(line)
                self.y[r] = Y_CODES[m["y"]]
                self.v[r] = m["v"]
                self.i[r] = m["i"]
                if "n" in m:
                    self.nb[r] = m["n"]
                if m["y"] == "fault":
                    for f in m["f"]:
                        self.fam[r, fi[f]] = True
                    self.pv[r] = pvc.get(m.get("pv"), 0)
                    self.noisy[r] = m.get("noisy", 0)
                    self.recipes[r] = m["r"]
        assert r + 1 == n, (name, r + 1, n)


def load_schema(set_dir):
    return json.load(open(os.path.join(set_dir, "schema.json")))


def load_views(set_dir):
    views = {}
    with gzip.open(os.path.join(set_dir, "views.jsonl.gz"), "rt") as fh:
        for line in fh:
            v = json.loads(line)
            p = v.get("page") or {}
            views[v["v"]] = {
                "host": v["host"], "group": v["group"], "domain": v["domain"], "device": v["device"],
                "scheme": v["scheme"], "round": v["round"], "split": v["split"], "dup": v["dup"],
                "pageLabels": v["pageLabels"], "applied": v["applied"], "vid": v["vid"],
                "ovx": (p.get("htmlOverflowX"), p.get("bodyOverflowX")), "vw": p.get("vw"), "vh": p.get("vh"),
            }
    return views


class Cols:
    def __init__(self, schema):
        self.names = schema["features"]
        self.ix = {n: k for k, n in enumerate(self.names)}
        self.cat = schema["categorical"]

    def __call__(self, X, name):
        return X[:, self.ix[name]]

    def code(self, cat, value):
        return self.cat[cat].get(value, -99)


def model_inputs(X, cols):
    """The learned models' input: every column except DROP, plus the box relative to the viewport."""
    keep = [k for k, n in enumerate(cols.names) if n not in DROP]
    vw = np.maximum(cols(X, "pVw"), 1)
    vh = np.maximum(cols(X, "pVh"), 1)
    x, y, w, h = cols(X, "x"), cols(X, "y"), cols(X, "w"), cols(X, "h")
    der = np.stack([x / vw, (x + w) / vw, y / vh, (y + h) / vh, w / vw, (w * h) / (vw * vh)], axis=1).astype(np.float32)
    return np.concatenate([X[:, keep], der], axis=1), [cols.names[k] for k in keep] + DERIVED


def input_names(schema):
    return [n for n in schema["features"] if n not in DROP] + DERIVED


def require_provenance(out_dir, skip=False):
    """Stop unless train/provenance.py passed on this training set (provenance.json in OUT with pass true)."""
    path = os.path.join(out_dir, "provenance.json")
    if skip:
        log("provenance gate skipped on request (--skip-provenance-gate); the results do not count")
        return None
    if not os.path.exists(path):
        raise SystemExit(f"provenance gate: {path} is missing; run train/provenance.py first")
    rep = json.load(open(path))
    auc = rep.get("auc")
    if not rep.get("pass") or auc is None or auc >= PROVENANCE_MAX_AUC:
        raise SystemExit(f"provenance gate: ROC AUC {auc} is not below {PROVENANCE_MAX_AUC}; see {path} (top inputs)")
    log(f"provenance gate passed: ROC AUC {auc:.4f} < {PROVENANCE_MAX_AUC}")
    return rep


def pick(S, rng, nat_n, natural_ok_only=True):
    """training rows: every fault, control and clean row, and up to nat_n natural rows (by default only those no
    measured signal marks)"""
    y = S.y
    idx = [np.flatnonzero(y == Y_CODES["fault"]), np.flatnonzero(y == Y_CODES["control"]), np.flatnonzero(y == Y_CODES["clean"])]
    nat = np.flatnonzero((y == Y_CODES["nat"]) & ((S.nb == 0) if natural_ok_only else True))
    if len(nat) > nat_n:
        nat = rng.choice(nat, nat_n, replace=False)
    idx.append(nat)
    return np.sort(np.concatenate(idx))


# ---------------------------------------------------------------- measured thresholds (VISUAL.md v1, element level)

RULES = ["image-broken", "media-failed", "text-invisible", "text-template-leak", "text-placeholder", "css-var-undefined",
         "image-distorted", "page-overflow-x", "font-failed", "pointer-events-leak", "scroll-lock-stuck", "click-blocked",
         "control-unreachable", "dialog-covered"]


def rules(S, cols, views):
    """Per-row bitmask of the v1 checks that can be read from one element row, with the VISUAL.md section 3
    thresholds. Checks that need events, timers, resource timing or a user action are approximated from the
    static row or left out (see TRAINING.md)."""
    X = S.X
    c = lambda n: cols(X, n)
    tag, role, pos, oy, fst, src, of = (c("cat_tag"), c("cat_role"), c("cat_pos"), c("cat_oy"), c("cat_fst"), c("cat_src"),
                                         c("cat_of"))
    T = lambda t: cols.code("tag", t)
    vis, inv, w, h = c("vis"), c("inv"), c("w"), c("h")
    vw = np.maximum(c("pVw"), 1)
    vh = np.maximum(c("pVh"), 1)
    out = np.zeros(X.shape[0], np.int32)
    bit = {r: 1 << k for k, r in enumerate(RULES)}
    img = tag == T("img")
    # 3.1 image-broken: complete, naturalWidth 0, visible, at least 16 x 16
    m = img & (c("cmp") == 1) & (c("iok") == 0) & (vis == 1) & (w >= 16) & (h >= 16)
    out[m] |= bit["image-broken"]
    # 3.3 media-failed: video error 2, 3 or 4, at least 48 x 48
    m = (tag == T("video")) & np.isin(c("verr"), [2, 3, 4]) & (w >= 48) & (h >= 48)
    out[m] |= bit["media-failed"]
    # 3.8 text-invisible: own text, visible, in the viewport, font >= 6 px, under 1.5:1 on a solid background,
    # no gradient text, text-fill colour, text-shadow, animation or disabled state; when the paint stack was read it
    # must agree (solid, under 1.5:1)
    cr, sbs, scr = c("cr"), c("sbs"), c("scr")
    stack_ok = (sbs == -1) | ((sbs == 0) & (scr >= 0) & (scr < 1.5))
    m = ((c("tl") >= 1) & (vis == 1) & (inv > 0) & (c("fs") >= 6) & (cr >= 0) & (cr < 1.5) & (c("ebs") == 0) &
         (c("bclip") == 0) & (c("tfcSet") == 0) & (c("tsh") == 0) & (c("an") == 0) & (c("dis") == 0) &
         ~np.isin(tag, [T("text"), T("tspan")]) & stack_ok)
    out[m] |= bit["text-invisible"]
    # 3.9 text-template-leak: a leak pattern in visible own text
    out[(c("lkN") > 0) & (vis == 1)] |= bit["text-template-leak"]
    # 3.10 text-placeholder: placeholder-image host (lorem ipsum is in the leak patterns)
    out[img & (src == cols.code("src", "ph")) & (vis == 1)] |= bit["text-placeholder"]
    # 3.12 css-var-undefined after the bench: an undefined var() whose text reads below 3:1 on a solid background
    m = ((c("vu") > 0) | (c("vi") > 0)) & (vis == 1) & (cr >= 0) & (cr < 3) & (c("ebs") == 0)
    out[m] |= bit["css-var-undefined"]
    # 3.13 image-distorted: loaded raster, object-fit fill, d > 0.05, mismatch > 2 px, both sides >= 48, natural > 5
    nw, nh = c("natW"), c("nh")
    a = nw / np.maximum(nh, 1)
    mis = np.minimum(np.abs(w - h * a), np.abs(h - w / np.maximum(a, 1e-6)))
    m = img & (c("iok") == 1) & (nw > 5) & (nh > 5) & (of == 0) & (c("dist") > 0.05) & (mis > 2) & (w >= 48) & (h >= 48)
    out[m] |= bit["image-distorted"]
    # 3.14 page-overflow-x culprits: page scrolls sideways, box past the right edge or left of 0, no clipping
    # ancestor, not fixed; the 3 shallowest per view are kept below
    x = c("x")
    m = (c("pSideways") == 1) & ((x + w > vw + 1) | (x < -1)) & (c("nca") == 0) & (pos != cols.code("pos", "f")) & (w > 0)
    ovx_ok = np.array([views[v]["ovx"][0] not in ("h", "c") and views[v]["ovx"][1] not in ("h", "c") for v in S.v[m]], bool)
    idx = np.flatnonzero(m)[ovx_ok]
    if len(idx):
        order = idx[np.lexsort((c("d")[idx], S.v[idx]))]
        keep = np.zeros(len(order), bool)
        last, k = -1, 0
        for j, r in enumerate(order):
            if S.v[r] != last:
                last, k = S.v[r], 0
            if k < 3:
                keep[j] = True
            k += 1
        out[order[keep]] |= bit["page-overflow-x"]
    # 3.5 font-failed: visible text in the viewport whose first family failed
    out[(fst == cols.code("fst", "e")) & (c("tl") > 0) & (vis == 1) & (inv > 0)] |= bit["font-failed"]
    # 3.19 pointer-events-leak: pointer-events none on body or html
    root = np.isin(tag, [T("body"), T("html")])
    out[root & (c("pen") == 1)] |= bit["pointer-events-leak"]
    # 3.20 scroll-lock-stuck (static part): body or html with overflow-y hidden or clip and > 100 px cut off
    out[root & np.isin(oy, [cols.code("oy", "h"), cols.code("oy", "c")]) & (c("shOver") > 100)] |= bit["scroll-lock-stuck"]
    # 3.18 click-blocked (static part): a transparent, textless, non-interactive layer of >= 30% of the viewport
    # that wins its own hit tests
    transp = (c("op") < 0.05) | ((c("bg3") < 0.05) & (c("bgi") == 0))
    m = ((c("ia") == 0) & (c("cur") == 0) & (c("tt") == 0) & transp & (w * h >= 0.3 * vw * vh) & (c("pen") == 0) &
         (c("hs") >= 3) & np.isin(pos, [cols.code("pos", "f"), cols.code("pos", "a")]) & ~root)
    out[m] |= bit["click-blocked"]
    # 3.21 control-unreachable (static part): a visible interactive element, at least half in the viewport, all 5
    # probes land on another element
    out[(c("ia") == 1) & (vis == 1) & (inv >= 0.5) & (c("ho") == 5)] |= bit["control-unreachable"]
    # 3.23 dialog-covered (static part): a visible dialog with at least 3 of 5 probes on another element
    dlg = np.isin(role, [cols.code("role", "dialog"), cols.code("role", "alertdialog")])
    out[dlg & (vis == 1) & (c("ho") >= 3)] |= bit["dialog-covered"]
    return out


PAGE_RULES = ["page-overflow-x (fact)", "viewport-meta-missing", "page-blank"]


def page_rules(S, cols, views):
    """Per-view page facts the v1 design reports without an element: sideways scroll, missing viewport meta on a
    phone, and a blank page (no visible text or media row)."""
    X = S.X
    c = lambda n: cols(X, n)
    vids, first_idx = np.unique(S.v, return_index=True)
    first = dict(zip(vids.tolist(), first_idx.tolist()))
    res = {}
    tag = c("cat_tag")
    T = lambda t: cols.code("tag", t)
    media = (np.isin(tag, [T("svg"), T("canvas"), T("video"), T("iframe")]) & (c("w") >= 16) & (c("h") >= 16)) | (
        (tag == T("img")) & (c("iok") == 1)) | (c("bgi") > 0)
    content = (c("vis") == 1) & ((c("tl") > 0) | media)
    has = np.zeros(int(S.v.max()) + 1, bool)
    np.logical_or.at(has, S.v, content)
    for v in vids.tolist():
        r = first[v]
        bits = 0
        ov = views[v]["ovx"]
        if X[r, cols.ix["pSideways"]] == 1 and ov[0] not in ("h", "c") and ov[1] not in ("h", "c"):
            bits |= 1
        if X[r, cols.ix["pDesktop"]] == 0 and X[r, cols.ix["pVmetaDW"]] == 0 and X[r, cols.ix["pVw"]] >= 585:
            bits |= 2
        if not has[v]:
            bits |= 4
        res[v] = bits
    return res
