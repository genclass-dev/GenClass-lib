#!/usr/bin/env python3
# Trains the Vision v1 student on the node's CPUs: a pretrained ImageNet backbone over the letterboxed crop, a few
# measured facts joined before the head, and four heads that copy Clef's family and verdict answers under its two
# prompts (clef-img-p3 "A", clef-imgonly-p2 "B").
#
#   train.py --arch mnv3s --epochs 8 --out OUT/models/<name> [--w-inj 0.5] [--bf16] [--limit 0]
#
# Targets: natural crops of training hosts get Clef's probability vectors (distillation); injected faults the pixel
# check saw get their family (one-hot) and "before"/"clean" pairs get "none"; nothing else. Hosts: round-2 train hosts
# minus the fresh test set's held-out hosts (OUT/test/heldout.json), minus 5% kept for a distillation check.
# The labelled crops (round 2, AI-agent labels) are scored after every epoch as dev data and never trained on.
# Writes model.pt, train.json (config, per-epoch losses and dev numbers) and dev scores (scores-dev.npz).

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
from common import OUT, IN_W, IN_H, FAMILIES, VERDICTS, INJ_FAMILY, INJ_VERDICT, FACT_NAMES  # noqa: E402
import metrics  # noqa: E402

PD = os.path.join(OUT, "pack")
MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1) * 255
STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1) * 255
TEACHERS = {"A": "clef-img-p3", "B": "clef-imgonly-p2"}


class Student(nn.Module):
    """uint8-range RGB (N, 3, 128, 224) + facts (N, 64) -> logits of famA, famB, verA, verB."""

    def __init__(self, arch="mnv3s", pretrained=True, nf=len(FACT_NAMES)):
        super().__init__()
        import torchvision
        if arch == "mnv3s":
            bb = torchvision.models.mobilenet_v3_small(weights="IMAGENET1K_V1" if pretrained else None)
            c = 576
        elif arch == "mnv3l":
            bb = torchvision.models.mobilenet_v3_large(weights="IMAGENET1K_V2" if pretrained else None)
            c = 960
        elif arch == "effb0":
            bb = torchvision.models.efficientnet_b0(weights="IMAGENET1K_V1" if pretrained else None)
            c = 1280
        else:
            raise ValueError(arch)
        self.features = bb.features
        self.register_buffer("mean", MEAN.clone())
        self.register_buffer("std", STD.clone())
        self.fact = nn.Sequential(nn.Linear(nf, 64), nn.ReLU(), nn.Linear(64, 64), nn.ReLU())
        self.trunk = nn.Sequential(nn.Linear(c + 64, 384), nn.Hardswish(), nn.Dropout(0.2))
        self.famA = nn.Linear(384, len(FAMILIES))
        self.famB = nn.Linear(384, len(FAMILIES))
        self.verA = nn.Linear(384, len(VERDICTS))
        self.verB = nn.Linear(384, len(VERDICTS))

    def forward(self, x, f):
        # keep channels-last after the broadcast (it falls back to NCHW, which runs the convolutions ~3x slower)
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


def teacher_targets(items):
    """Per teacher: (n, 11) family and (n, 8) verdict probabilities and a mask of crops it answered."""
    from clef_label import answered
    out = {}
    for t, v in TEACHERS.items():
        ans = answered(v)
        fam = np.zeros((len(items), len(FAMILIES)), np.float32)
        ver = np.zeros((len(items), len(VERDICTS)), np.float32)
        m = np.zeros(len(items), bool)
        for k, it in enumerate(items):
            r = ans.get(it["id"])
            if not r:
                continue
            pf, pv = r["answers"]["family"]["probabilities"], r["answers"]["verdict"]["probabilities"]
            fam[k] = [pf.get(c, 0.0) for c in FAMILIES]
            ver[k] = [pv.get(c, 0.0) for c in VERDICTS]
            sf, sv = fam[k].sum(), ver[k].sum()
            if sf <= 0 or sv <= 0:
                continue
            fam[k] /= sf
            ver[k] /= sv
            m[k] = True
        out[t] = (fam, ver, m)
    return out


def injected_targets(items):
    fam = np.zeros((len(items), len(FAMILIES)), np.float32)
    ver = np.zeros((len(items), len(VERDICTS)), np.float32)
    mv = np.zeros(len(items), bool)
    for k, it in enumerate(items):
        if it["kind"] == "fault":
            f = (it.get("families") or ["other"])[0]
            fam[k, FAMILIES.index(INJ_FAMILY.get(f, "other"))] = 1
            if f in INJ_VERDICT:
                ver[k, VERDICTS.index(INJ_VERDICT[f])] = 1
                mv[k] = True
        else:
            fam[k, 0] = 1
            ver[k, 0] = 1
            mv[k] = True
    return fam, ver, mv


def host_bucket(g, salt="vision-v1-distill-val"):
    return int(hashlib.sha256((salt + ":" + g).encode()).hexdigest()[:8], 16) / 2**32


def batches(sets, order, bs, rng, train=True, shift=8, p_degrade=0.5):
    """Yields (x float tensor NCHW in 0..255, facts, idx) in the order of `order` rows ([set, row] pairs). Full-
    resolution crops are swapped for their degraded copy with probability p_degrade; a batch is shifted by up to
    `shift` px (the same shift for the whole batch)."""
    nf = sets[0][3].shape[1]
    for s in range(0, len(order), bs):
        idx = order[s: s + bs]
        x = np.empty((len(idx), IN_H, IN_W, 3), np.uint8)
        f = np.empty((len(idx), nf), np.float32)
        for si in np.unique(idx[:, 0]):
            sel = np.nonzero(idx[:, 0] == si)[0]
            rows = idx[sel, 1]
            o = np.argsort(rows)
            sel, rows = sel[o], rows[o]
            _, X, Xd, F, full = sets[si]
            a = np.asarray(X[rows])
            if train and full is not None:
                pick = (rng.random(len(rows)) < p_degrade) & full[rows]
                if pick.any():
                    a[pick] = np.asarray(Xd[rows[pick]])
            x[sel] = a
            f[sel] = F[rows]
        t = torch.from_numpy(x).permute(0, 3, 1, 2).float()
        if train and shift:
            dx, dy = rng.integers(-shift, shift + 1, 2)
            t = torch.roll(t, shifts=(int(dy), int(dx)), dims=(2, 3))
        yield t.contiguous(memory_format=torch.channels_last), torch.from_numpy(f), idx


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


def soft_ce(logits, target, mask):
    if mask.sum() == 0:
        return logits.sum() * 0
    lp = Fn.log_softmax(logits.float(), 1)
    return -(target * lp).sum(1)[mask].mean()


def any_logit(fam_logits):
    """logit of 1 - P(none) from family logits."""
    lp = Fn.log_softmax(fam_logits.float(), 1)
    p_none = lp[:, 0].exp().clamp(1e-6, 1 - 1e-6)
    return torch.log((1 - p_none) / p_none)


@torch.no_grad()
def score(model, X, F, bs=512, bf16=False):
    """Per crop: family probabilities A, B and their mean, verdict probabilities A, B, and the anyProblem scores."""
    model.eval()
    outs = {k: [] for k in ("famA", "famB", "verA", "verB")}
    for s in range(0, len(F), bs):
        x = torch.from_numpy(np.asarray(X[s: s + bs])).permute(0, 3, 1, 2).float().contiguous(memory_format=torch.channels_last)
        f = torch.from_numpy(np.asarray(F[s: s + bs]))
        with torch.autocast("cpu", dtype=torch.bfloat16, enabled=bf16):
            fa, fb, va, vb = model(x, f)
        for k, z in zip(("famA", "famB", "verA", "verB"), (fa, fb, va, vb)):
            outs[k].append(torch.softmax(z.float(), 1).numpy())
    o = {k: np.concatenate(v) for k, v in outs.items()}
    lg = lambda p: np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    o["anyA"] = 1 - o["famA"][:, 0]
    o["anyB"] = 1 - o["famB"][:, 0]
    o["any"] = 1 / (1 + np.exp(-(lg(o["anyA"]) + lg(o["anyB"])) / 2))
    o["fam"] = (o["famA"] + o["famB"]) / 2
    return o


def dev_metrics(o, items):
    """AP of the anyProblem scores on the labelled dev crops (round-2 labels; unclear left out)."""
    k = [i for i, it in enumerate(items) if it["kind"] == "lab" and it["verdict"] != "unclear"]
    y = np.array([items[i]["verdict"] == "real" for i in k], float)
    out = {"n": len(k), "real": int(y.sum())}
    for s in ("anyA", "anyB", "any"):
        out[s] = round(metrics.ap(y, o[s][k]), 4)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="mnv3s")
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--lr-backbone", type=float, default=4e-4)
    ap.add_argument("--wd", type=float, default=1e-4)
    ap.add_argument("--w-inj", type=float, default=0.5)
    ap.add_argument("--w-ver", type=float, default=0.5)
    ap.add_argument("--p-degrade", type=float, default=0.5)
    ap.add_argument("--bf16", action="store_true")
    ap.add_argument("--threads", type=int, default=78)
    ap.add_argument("--limit", type=int, default=0, help="training crops per epoch (0: all), for quick runs")
    ap.add_argument("--no-pretrained", action="store_true")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    torch.manual_seed(a.seed)
    rng = np.random.default_rng(a.seed)
    os.makedirs(a.out, exist_ok=True)
    held = set(json.load(open(os.path.join(OUT, "test", "heldout.json")))["g"])

    nat, Xn, Xnd, Fn_ = load_pack("nat")
    inj, Xi, Xid, Fi = load_pack("inj")
    lab, Xl, Xld, Fl = load_pack("lab")
    T = teacher_targets(nat)
    ifam, iver, imv = injected_targets(inj)
    full_n = np.array([it["src"] == "crawl" for it in nat])
    nat_ok = np.array([it["g"] not in held for it in nat]) & (T["A"][2] | T["B"][2])
    inj_ok = np.array([it["g"] not in held for it in inj])
    dval_n = np.array([host_bucket(it["g"]) < 0.05 for it in nat])
    dval_i = np.array([host_bucket(it["g"]) < 0.05 for it in inj])
    tr_n = np.nonzero(nat_ok & ~dval_n)[0]
    tr_i = np.nonzero(inj_ok & ~dval_i)[0] if a.w_inj > 0 else np.zeros(0, int)
    va_n = np.nonzero(nat_ok & dval_n)[0]
    sets = [("nat", Xn, Xnd, Fn_, full_n), ("inj", Xi, Xid, Fi, None)]
    info = {"config": vars(a), "trainNatural": int(len(tr_n)), "trainInjected": int(len(tr_i)), "distillVal": int(len(va_n)),
            "heldOutNaturalExcluded": int(sum(1 for it in nat if it["g"] in held)),
            "teacherCoverage": {t: int(T[t][2].sum()) for t in T}, "epochs": []}
    print(json.dumps({k: v for k, v in info.items() if k != "config"}), flush=True)

    model = Student(a.arch, pretrained=not a.no_pretrained).to(memory_format=torch.channels_last)
    bb = [p for n, p in model.named_parameters() if n.startswith("features.")]
    hd = [p for n, p in model.named_parameters() if not n.startswith("features.")]
    opt = torch.optim.AdamW([{"params": bb, "lr": a.lr_backbone}, {"params": hd, "lr": a.lr}], weight_decay=a.wd)
    base_lr = [a.lr_backbone, a.lr]
    per_epoch = len(tr_n) + len(tr_i) if not a.limit else a.limit
    steps = a.epochs * math.ceil(per_epoch / a.bs)
    warm = min(300, steps // 10)
    step = 0
    t_start = time.time()
    best = None
    for ep in range(a.epochs):
        model.train()
        order = np.concatenate([np.stack([np.zeros(len(tr_n), int), tr_n], 1), np.stack([np.ones(len(tr_i), int), tr_i], 1)])
        rng.shuffle(order)
        if a.limit:
            order = order[: a.limit]
        tl, tn, t0 = 0.0, 0, time.time()
        for x, f, idx in prefetch(batches(sets, order, a.bs, rng, p_degrade=a.p_degrade)):
            lr_f = min(1.0, (step + 1) / max(1, warm)) * 0.5 * (1 + math.cos(math.pi * min(1.0, step / steps)))
            for g, b in zip(opt.param_groups, base_lr):
                g["lr"] = b * lr_f
            si, ri = idx[:, 0], idx[:, 1]
            isn = si == 0
            tfa = np.zeros((len(idx), len(FAMILIES)), np.float32)
            tfb, tva, tvb = tfa.copy(), np.zeros((len(idx), len(VERDICTS)), np.float32), np.zeros((len(idx), len(VERDICTS)), np.float32)
            ma, mb, mva, mvb = (np.zeros(len(idx), bool) for _ in range(4))
            w = np.ones(len(idx), np.float32)
            rn, ri_ = ri[isn], ri[~isn]
            tfa[isn], tva[isn], ma[isn] = T["A"][0][rn], T["A"][1][rn], T["A"][2][rn]
            tfb[isn], tvb[isn], mb[isn] = T["B"][0][rn], T["B"][1][rn], T["B"][2][rn]
            tfa[~isn], tfb[~isn] = ifam[ri_], ifam[ri_]
            tva[~isn], tvb[~isn] = iver[ri_], iver[ri_]
            ma[~isn], mb[~isn] = True, True
            mva[isn], mvb[isn] = ma[isn], mb[isn]
            mva[~isn], mvb[~isn] = imv[ri_], imv[ri_]
            w[~isn] = a.w_inj
            tt = torch.from_numpy
            wt = torch.from_numpy(w)
            with torch.autocast("cpu", dtype=torch.bfloat16, enabled=a.bf16):
                za, zb, va, vb = model(x, f)
            lossf = lambda z, t, m: (wt[m] * -(t[m] * Fn.log_softmax(z.float()[m], 1)).sum(1)).sum() / max(1.0, float(wt[m].sum()))
            loss = (lossf(za, tt(tfa), tt(ma)) + lossf(zb, tt(tfb), tt(mb)) +
                    a.w_ver * (lossf(va, tt(tva), tt(mva)) + lossf(vb, tt(tvb), tt(mvb))))
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            step += 1
            tl += float(loss) * len(idx)
            tn += len(idx)
            if step % 50 == 0:
                print("ep %d step %d/%d loss %.4f  %.0f img/s" % (ep, step, steps, tl / tn, tn / (time.time() - t0)), flush=True)
        # distillation check on held-back training hosts and the labelled dev crops
        ov = score(model, Xn[np.sort(va_n)] if len(va_n) else Xn[:0], Fn_[np.sort(va_n)], bf16=a.bf16)
        vs = np.sort(va_n)
        dv = {}
        for t in ("A", "B"):
            m = T[t][2][vs]
            tp = T[t][0][vs][m]
            sp = ov["fam" + t][m]
            dv["kl" + t] = round(float(np.mean((tp * (np.log(np.clip(tp, 1e-7, 1)) - np.log(np.clip(sp, 1e-7, 1)))).sum(1))), 4)
            ta, sa = 1 - tp[:, 0], ov["any" + t][m]
            dv["corrAny" + t] = round(float(np.corrcoef(ta, sa)[0, 1]), 4)
            top = ta >= np.quantile(ta, 0.9)
            dv["apTop10" + t] = round(metrics.ap(top.astype(float), sa), 4)
        od = score(model, Xl, Fl, bf16=a.bf16)
        odd = score(model, Xld, Fl, bf16=a.bf16)
        rec = {"epoch": ep, "trainLoss": round(tl / max(1, tn), 4), "seconds": round(time.time() - t0), "imgPerS": round(tn / (time.time() - t0)),
               "distillVal": dv, "dev": dev_metrics(od, lab), "devDegraded": dev_metrics(odd, lab)}
        info["epochs"].append(rec)
        print(json.dumps(rec), flush=True)
        torch.save({"state": model.state_dict(), "arch": a.arch, "epoch": ep}, os.path.join(a.out, "model-ep%d.pt" % ep))
        np.savez(os.path.join(a.out, "scores-dev-ep%d.npz" % ep), **{k: v for k, v in od.items()},
                 **{"deg_" + k: v for k, v in odd.items()})
    info["trainSeconds"] = round(time.time() - t_start)
    torch.save({"state": model.state_dict(), "arch": a.arch, "epoch": a.epochs - 1}, os.path.join(a.out, "model.pt"))
    json.dump(info, open(os.path.join(a.out, "train.json"), "w"), indent=1)
    print("done in %d s" % info["trainSeconds"])


if __name__ == "__main__":
    main()
