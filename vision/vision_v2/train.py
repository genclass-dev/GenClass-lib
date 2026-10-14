#!/usr/bin/env python3
# Trains the Vision v2 student on the node's CPUs, from the Vision v1 recipe (vision/vision_v1/train.py): a pretrained
# ImageNet MobileNetV3 over the letterboxed crop, the 64 measured facts joined before the head, soft cross-entropy
# against a teacher's probabilities. The teacher is now OpenAI's Decisions API (gpt-6-luna, the luna-img-p3 prompt):
#
#   heads   ver (8): OpenAI's verdict probabilities      -> the score notFine = 1 - P(verdict = fine)
#           fam (11): the family probabilities           -> --fam-target luna: OpenAI's family answer
#                                                           --fam-target avg: the mean of OpenAI's and Clef's family
#                                                           answers (Clef = the mean of its two prompts)
#           any (1, optional, --any-head): a binary soft target, the mean of OpenAI's notFine and Clef's anyProblem
#
#   train.py --fam-target luna --epochs 12 --lr 5e-3 --lr-backbone 2e-3 --out OUT/models/<name> [--bf16]
#
# Data: Vision v1's 100,000 natural crops of round-2 train hosts (its pack, 224 x 128, with degraded copies of the
# full-resolution crops), minus the frozen test set's 815 held-out hosts, minus the fresh dev set's hosts (devset.py),
# minus 5% of hosts kept back to measure agreement with the teacher. No injected faults (Vision v1 found they hurt).
# After each epoch the student scores the fresh dev crops (scores saved; model choice uses them once their labels
# exist) and the round-2 labelled crops (dev data of Vision v1, for continuity). Nothing here reads a test label.

import argparse
import hashlib
import json
import math
import os
import queue
import sys
import threading
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as Fn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import OUT, V1, PACK_DIR, IN_W, IN_H, FAMILIES, VERDICTS, FACT_NAMES  # noqa: E402
import metrics  # noqa: E402

PD = PACK_DIR
MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1) * 255
STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1) * 255


def backbone(arch, pretrained):
    import torchvision
    if arch == "mnv3s":
        return torchvision.models.mobilenet_v3_small(weights="IMAGENET1K_V1" if pretrained else None).features, 576
    if arch == "mnv3l":
        return torchvision.models.mobilenet_v3_large(weights="IMAGENET1K_V2" if pretrained else None).features, 960
    raise ValueError(arch)


class Student(nn.Module):
    """uint8-range RGB (N, 3, H, W) + facts (N, 64) -> logits of fam (11), ver (8) and, with any_head, any (1)."""

    def __init__(self, arch="mnv3s", pretrained=True, nf=len(FACT_NAMES), any_head=False):
        super().__init__()
        self.features, c = backbone(arch, pretrained)
        self.register_buffer("mean", MEAN.clone())
        self.register_buffer("std", STD.clone())
        self.fact = nn.Sequential(nn.Linear(nf, 64), nn.ReLU(), nn.Linear(64, 64), nn.ReLU())
        self.trunk = nn.Sequential(nn.Linear(c + 64, 384), nn.Hardswish(), nn.Dropout(0.2))
        self.fam = nn.Linear(384, len(FAMILIES))
        self.ver = nn.Linear(384, len(VERDICTS))
        self.any_head = any_head
        if any_head:
            self.anyh = nn.Linear(384, 1)

    def forward(self, x, f):
        x = ((x - self.mean) / self.std).contiguous(memory_format=torch.channels_last)
        h = self.features(x).mean((2, 3))
        z = self.trunk(torch.cat([h, self.fact(f)], 1))
        out = (self.fam(z), self.ver(z))
        return out + (self.anyh(z)[:, 0],) if self.any_head else out


class StudentV1(nn.Module):
    """Vision v1's student (vision/vision_v1/train.py Student, copied) so its checkpoint can be scored next to v2."""

    def __init__(self, arch="mnv3s", nf=len(FACT_NAMES), any_head=False):
        super().__init__()
        self.features, c = backbone(arch, False)
        self.register_buffer("mean", MEAN.clone())
        self.register_buffer("std", STD.clone())
        self.fact = nn.Sequential(nn.Linear(nf, 64), nn.ReLU(), nn.Linear(64, 64), nn.ReLU())
        self.trunk = nn.Sequential(nn.Linear(c + 64, 384), nn.Hardswish(), nn.Dropout(0.2))
        self.famA = nn.Linear(384, len(FAMILIES))
        self.famB = nn.Linear(384, len(FAMILIES))
        self.verA = nn.Linear(384, len(VERDICTS))
        self.verB = nn.Linear(384, len(VERDICTS))
        self.any_head = any_head
        if any_head:
            self.anyT = nn.Linear(384, 1)

    def forward(self, x, f):
        x = ((x - self.mean) / self.std).contiguous(memory_format=torch.channels_last)
        h = self.features(x).mean((2, 3))
        z = self.trunk(torch.cat([h, self.fact(f)], 1))
        return self.famA(z), self.famB(z), self.verA(z), self.verB(z)


def load_pack(name):
    meta = json.load(open(os.path.join(PD, name + ".json")))
    n = meta["n"]
    X = np.memmap(os.path.join(PD, name + ".X.u8"), dtype=np.uint8, mode="r", shape=(n, IN_H, IN_W, 3))
    Xd = np.memmap(os.path.join(PD, name + ".Xd.u8"), dtype=np.uint8, mode="r", shape=(n, IN_H, IN_W, 3))
    F = np.fromfile(os.path.join(PD, name + ".F.f32"), dtype=np.float32).reshape(n, -1)
    return meta["items"], X, Xd, F


def lgt(p):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def teacher_arrays(items):
    """Per crop: OpenAI verdict (8) and family (11) probabilities with a mask, and Clef's family (11, mean of its two
    prompts) and anyProblem (sigmoid of the mean of the two prompts' logits) with a mask."""
    from clef_answers import answered, luna
    L = luna()
    lv = np.zeros((len(items), len(VERDICTS)), np.float32)
    lf = np.zeros((len(items), len(FAMILIES)), np.float32)
    lm = np.zeros(len(items), bool)
    for k, it in enumerate(items):
        r = L.get(it["id"])
        if not r:
            continue
        v = np.array([r["verdict"].get(c, 0.0) for c in VERDICTS], np.float32)
        f = np.array([r["family"].get(c, 0.0) for c in FAMILIES], np.float32)
        if v.sum() <= 0 or f.sum() <= 0:
            continue
        lv[k], lf[k], lm[k] = v / v.sum(), f / f.sum(), True
    cf = np.zeros((len(items), len(FAMILIES)), np.float32)
    ca = np.zeros(len(items), np.float32)
    cm = np.zeros(len(items), bool)
    A, Bv = answered("clef-img-p3"), answered("clef-imgonly-p2")
    for k, it in enumerate(items):
        ps = []
        for store in (A, Bv):
            r = store.get(it["id"])
            if r:
                p = np.array([r["answers"]["family"]["probabilities"].get(c, 0.0) for c in FAMILIES], np.float32)
                if p.sum() > 0:
                    ps.append(p / p.sum())
        if ps:
            cf[k] = np.mean(ps, 0)
            ca[k] = 1 / (1 + np.exp(-np.mean([lgt(1 - p[0]) for p in ps])))
            cm[k] = True
    return {"lunaVer": lv, "lunaFam": lf, "lunaMask": lm, "clefFam": cf, "clefAny": ca, "clefMask": cm}


def host_bucket(g, salt="vision-v1-distill-val"):
    return int(hashlib.sha256((salt + ":" + g).encode()).hexdigest()[:8], 16) / 2**32


def batches(X, Xd, F, full, order, bs, rng, train=True, shift=8, p_degrade=0.5):
    for s in range(0, len(order), bs):
        rows = np.sort(order[s: s + bs])
        a = np.asarray(X[rows])
        if train and full is not None:
            pick = (rng.random(len(rows)) < p_degrade) & full[rows]
            if pick.any():
                a[pick] = np.asarray(Xd[rows[pick]])
        t = torch.from_numpy(a).permute(0, 3, 1, 2).float()
        if train and shift:
            dx, dy = rng.integers(-shift, shift + 1, 2)
            t = torch.roll(t, shifts=(int(dy), int(dx)), dims=(2, 3))
        yield t.contiguous(memory_format=torch.channels_last), torch.from_numpy(F[rows]), rows


def prefetch(gen, n=3):
    q = queue.Queue(n)

    def run():
        for b in gen:
            q.put(b)
        q.put(None)

    threading.Thread(target=run, daemon=True).start()
    while True:
        b = q.get()
        if b is None:
            return
        yield b


@torch.no_grad()
def score(model, X, F, bs=512, bf16=False):
    """Per crop: fam (11) and ver (8) probabilities, notFine = 1 - P(ver = fine), anyF = 1 - P(fam = none) and, with
    the any head, anyH."""
    model.eval()
    fam, ver, anyh = [], [], []
    for s in range(0, len(F), bs):
        x = torch.from_numpy(np.asarray(X[s: s + bs])).permute(0, 3, 1, 2).float().contiguous(memory_format=torch.channels_last)
        f = torch.from_numpy(np.asarray(F[s: s + bs]))
        with torch.autocast("cpu", dtype=torch.bfloat16, enabled=bf16):
            r = model(x, f)
        fam.append(torch.softmax(r[0].float(), 1).numpy())
        ver.append(torch.softmax(r[1].float(), 1).numpy())
        if len(r) > 2:
            anyh.append(torch.sigmoid(r[2].float()).numpy())
    o = {"fam": np.concatenate(fam), "ver": np.concatenate(ver)}
    o["notFine"] = 1 - o["ver"][:, 0]
    o["anyF"] = 1 - o["fam"][:, 0]
    if anyh:
        o["anyH"] = np.concatenate(anyh)
    return o


def fresh_dev():
    """Rows of the fresh dev crops in the nat pack, in manifest order, and their labels when they exist."""
    man = [json.loads(l) for l in open(os.path.join(OUT, "dev", "manifest.jsonl"))]
    lp = os.path.join(OUT, "dev", "labels.json")
    lab = json.load(open(lp))["labels"] if os.path.exists(lp) else None
    return man, lab


def dev_ap(o, y, keys=("notFine", "anyF", "anyH")):
    return {k: round(metrics.ap(y, o[k]), 4) for k in keys if k in o}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="mnv3s")
    ap.add_argument("--fam-target", default="luna", choices=["luna", "avg"])
    ap.add_argument("--any-head", action="store_true", help="add a binary head on mean(OpenAI notFine, Clef anyProblem)")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=5e-3)
    ap.add_argument("--lr-backbone", type=float, default=2e-3)
    ap.add_argument("--wd", type=float, default=1e-4)
    ap.add_argument("--w-ver", type=float, default=1.0)
    ap.add_argument("--w-fam", type=float, default=1.0)
    ap.add_argument("--w-any", type=float, default=1.0)
    ap.add_argument("--p-degrade", type=float, default=0.5)
    ap.add_argument("--bf16", action="store_true")
    ap.add_argument("--threads", type=int, default=19)
    ap.add_argument("--limit", type=int, default=0, help="training crops per epoch (0: all), for quick runs")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    torch.manual_seed(a.seed)
    rng = np.random.default_rng(a.seed)
    os.makedirs(a.out, exist_ok=True)
    held = set(json.load(open(os.path.join(V1, "test", "heldout.json")))["g"])
    devg = set(json.load(open(os.path.join(OUT, "dev", "devhosts.json")))["g"])

    nat, Xn, Xnd, Fnat = load_pack("nat")
    lab, Xl, Xld, Fl = load_pack("lab")
    T = teacher_arrays(nat)
    full = np.array([it["src"] == "crawl" for it in nat])
    g = np.array([it["g"] for it in nat])
    out_test = np.array([x in held for x in g])
    out_dev = np.array([x in devg for x in g])
    dval = np.array([host_bucket(x) < 0.05 for x in g])
    ok = T["lunaMask"] & ~out_test & ~out_dev
    if a.fam_target == "avg" or a.any_head:
        ok &= T["clefMask"]
    tr = np.nonzero(ok & ~dval)[0]
    va = np.nonzero(ok & dval)[0]
    # targets
    tver = T["lunaVer"]
    if a.fam_target == "luna":
        tfam = T["lunaFam"]
    else:
        tfam = (T["lunaFam"] + T["clefFam"]) / 2
    tany = ((1 - T["lunaVer"][:, 0]) + T["clefAny"]) / 2
    # the fresh dev crops (scored every epoch) and the round-2 labelled crops
    man, dlab = fresh_dev()
    row_of = {it["id"]: k for k, it in enumerate(nat)}
    drows = np.array([row_of[m["crop"]] for m in man])
    assert not ok[drows].any() and not np.isin(drows, tr).any()
    lrows = [k for k, it in enumerate(lab) if it["kind"] == "lab" and it["verdict"] != "unclear"]
    ly = np.array([lab[k]["verdict"] == "real" for k in lrows], float)

    info = {"config": vars(a), "train": int(len(tr)), "distillVal": int(len(va)), "excludedTestHosts": int(out_test.sum()),
            "excludedDevHosts": int(out_dev.sum()), "lunaCoverage": int(T["lunaMask"].sum()), "clefCoverage": int(T["clefMask"].sum()),
            "epochs": []}
    print(json.dumps({k: v for k, v in info.items() if k != "config"}), flush=True)

    model = Student(a.arch, pretrained=True, any_head=a.any_head).to(memory_format=torch.channels_last)
    bb = [p for n, p in model.named_parameters() if n.startswith("features.")]
    hd = [p for n, p in model.named_parameters() if not n.startswith("features.")]
    opt = torch.optim.AdamW([{"params": bb, "lr": a.lr_backbone}, {"params": hd, "lr": a.lr}], weight_decay=a.wd)
    base_lr = [a.lr_backbone, a.lr]
    per_epoch = len(tr) if not a.limit else a.limit
    steps = a.epochs * math.ceil(per_epoch / a.bs)
    warm = min(300, steps // 10)
    step = 0
    t_start = time.time()
    sce = lambda z, t: -(t * Fn.log_softmax(z.float(), 1)).sum(1).mean()
    for ep in range(a.epochs):
        model.train()
        order = tr.copy()
        rng.shuffle(order)
        if a.limit:
            order = order[: a.limit]
        tl, tn, t0 = 0.0, 0, time.time()
        for x, f, rows in prefetch(batches(Xn, Xnd, Fnat, full, order, a.bs, rng, p_degrade=a.p_degrade)):
            lr_f = min(1.0, (step + 1) / max(1, warm)) * 0.5 * (1 + math.cos(math.pi * min(1.0, step / steps)))
            for gr, b in zip(opt.param_groups, base_lr):
                gr["lr"] = b * lr_f
            with torch.autocast("cpu", dtype=torch.bfloat16, enabled=a.bf16):
                r = model(x, f)
            loss = a.w_fam * sce(r[0], torch.from_numpy(tfam[rows])) + a.w_ver * sce(r[1], torch.from_numpy(tver[rows]))
            if a.any_head:
                loss = loss + a.w_any * Fn.binary_cross_entropy_with_logits(r[2].float(), torch.from_numpy(tany[rows]))
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            step += 1
            tl += float(loss) * len(rows)
            tn += len(rows)
            if step % 50 == 0:
                print("ep %d step %d/%d loss %.4f  %.0f img/s" % (ep, step, steps, tl / tn, tn / (time.time() - t0)), flush=True)
        # agreement with the teacher on held-back training hosts
        vs = np.sort(va)
        ov = score(model, Xn[vs], Fnat[vs], bf16=a.bf16)
        tnf = 1 - tver[vs][:, 0]
        top = tnf >= np.quantile(tnf, 0.9)
        dv = {"corrNotFine": round(float(np.corrcoef(tnf, ov["notFine"])[0, 1]), 4),
              "apTop10NotFine": round(metrics.ap(top.astype(float), ov["notFine"]), 4),
              "klVer": round(float(np.mean((tver[vs] * (np.log(np.clip(tver[vs], 1e-7, 1)) - np.log(np.clip(ov["ver"], 1e-7, 1)))).sum(1))), 4),
              "klFam": round(float(np.mean((tfam[vs] * (np.log(np.clip(tfam[vs], 1e-7, 1)) - np.log(np.clip(ov["fam"], 1e-7, 1)))).sum(1))), 4)}
        # fresh dev crops (full-resolution input) and the round-2 labelled crops
        od = score(model, Xn[drows], Fnat[drows], bf16=a.bf16)
        ol = score(model, Xl[np.array(lrows)], Fl[np.array(lrows)], bf16=a.bf16)
        rec = {"epoch": ep, "trainLoss": round(tl / max(1, tn), 4), "seconds": round(time.time() - t0),
               "imgPerS": round(tn / (time.time() - t0)), "distillVal": dv, "round2Dev": dev_ap(ol, ly)}
        if dlab:
            keep = [i for i, m in enumerate(man) if dlab[m["dev"]]["verdict"] != "unclear"]
            y = np.array([dlab[man[i]["dev"]]["verdict"] == "real" for i in keep], float)
            rec["freshDev"] = dev_ap({k: v[keep] for k, v in od.items() if v.ndim == 1}, y)
        info["epochs"].append(rec)
        print(json.dumps(rec), flush=True)
        ck = {"state": model.state_dict(), "arch": a.arch, "epoch": ep, "anyHead": a.any_head, "input": [IN_W, IN_H],
              "famTarget": a.fam_target}
        torch.save(ck, os.path.join(a.out, "model-ep%d.pt" % ep))
        np.savez(os.path.join(a.out, "scores-freshdev-ep%d.npz" % ep), **od)
        json.dump(info, open(os.path.join(a.out, "train.json"), "w"), indent=1)
    info["trainSeconds"] = round(time.time() - t_start)
    torch.save(ck, os.path.join(a.out, "model.pt"))
    json.dump(info, open(os.path.join(a.out, "train.json"), "w"), indent=1)
    print("done in %d s" % info["trainSeconds"], flush=True)


if __name__ == "__main__":
    main()
