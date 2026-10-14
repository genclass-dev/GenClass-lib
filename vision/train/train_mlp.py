"""A small MLP on the same rows and inputs as train_gbt.py (PyTorch, CPU; runs with the jev venv on the node).

    ~/jev/.venv/bin/python vision/train/train_mlp.py --set ~/vision-out/trainset --out ~/vision-out/models

Numeric inputs: sign(x) * log1p(|x|), then standardised on the training rows. Categorical inputs: an 8-wide
embedding per column. Two hidden layers (256, 128), ReLU, dropout 0.1, binary cross-entropy with the same row
weights as the trees; the epoch with the best dev average precision is kept. Writes scores-mlp-<split>.npy.
"""

import argparse
import json
import os
import time

import numpy as np
import torch
from torch import nn

from common import Cols, Split, Y_CODES, load_schema, log, model_inputs, pick, require_provenance


def ap_score(y, p):
    o = np.argsort(-p, kind="stable")
    y = y[o]
    tp = np.cumsum(y)
    prec = tp / np.arange(1, len(y) + 1)
    return float((prec * y).sum() / max(1, y.sum()))


class Net(nn.Module):
    def __init__(self, n_num, cards):
        super().__init__()
        self.emb = nn.ModuleList([nn.Embedding(c, 8) for c in cards])
        self.mlp = nn.Sequential(nn.Linear(n_num + 8 * len(cards), 256), nn.ReLU(), nn.Dropout(0.1),
                                 nn.Linear(256, 128), nn.ReLU(), nn.Dropout(0.1), nn.Linear(128, 1))

    def forward(self, xn, xc):
        e = [m(xc[:, k]) for k, m in enumerate(self.emb)]
        return self.mlp(torch.cat([xn] + e, 1)).squeeze(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=os.path.expanduser("~/vision-out/trainset"))
    ap.add_argument("--out", default=os.path.expanduser("~/vision-out/models"))
    ap.add_argument("--nat", type=int, default=800000)
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--skip-provenance-gate", action="store_true", help="debug only: results do not count")
    a = ap.parse_args()
    require_provenance(a.out, a.skip_provenance_gate)
    torch.manual_seed(a.seed)
    torch.set_num_threads(os.cpu_count())
    schema = load_schema(a.set)
    cols = Cols(schema)
    rng = np.random.default_rng(a.seed)
    tr = Split(a.set, "train", schema)
    va = Split(a.set, "val", schema)
    itr = pick(tr, rng, a.nat)
    iva = pick(va, rng, 200000)
    Xtr, names = model_inputs(tr.X[itr], cols)
    cat = [k for k, n in enumerate(names) if n.startswith("cat_")]
    num = [k for k, n in enumerate(names) if not n.startswith("cat_")]
    cards = [int(Xtr[:, k].max()) + 2 for k in cat]

    def prep(X):
        xn = np.sign(X[:, num]) * np.log1p(np.abs(X[:, num]))
        return xn, np.clip(X[:, cat], 0, None).astype(np.int64)

    xn, xc = prep(Xtr)
    mu, sd = xn.mean(0), xn.std(0) + 1e-6
    xn = ((xn - mu) / sd).astype(np.float32)
    ytr = (tr.y[itr] == Y_CODES["fault"]).astype(np.float32)
    wtr = np.where(tr.y[itr] == Y_CODES["control"], 3.0, 1.0).astype(np.float32)
    Xva, _ = model_inputs(va.X[iva], cols)
    vn, vc = prep(Xva)
    vn = ((vn - mu) / sd).astype(np.float32)
    yva = (va.y[iva] == Y_CODES["fault"]).astype(np.float32)
    for k, c in enumerate(cards):
        vc[:, k] = np.minimum(vc[:, k], c - 1)
    net = Net(len(num), cards)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-4)
    lossf = nn.BCEWithLogitsLoss(reduction="none")
    XN, XC, Y, W = map(torch.from_numpy, (xn, xc, ytr, wtr))
    VN, VC = torch.from_numpy(vn), torch.from_numpy(vc)
    best, best_state, hist = -1, None, []
    t0 = time.time()
    for ep in range(a.epochs):
        net.train()
        perm = torch.randperm(len(Y))
        for b in range(0, len(Y), 4096):
            j = perm[b:b + 4096]
            opt.zero_grad()
            loss = (lossf(net(XN[j], XC[j]), Y[j]) * W[j]).mean()
            loss.backward()
            opt.step()
        net.eval()
        with torch.no_grad():
            pv = torch.cat([net(VN[b:b + 65536], VC[b:b + 65536]) for b in range(0, len(VN), 65536)]).numpy()
        s = ap_score(yva, pv)
        hist.append(round(s, 4))
        log(f"epoch {ep + 1}: dev AP {s:.4f}")
        if s > best:
            best, best_state = s, {k: v.clone() for k, v in net.state_dict().items()}
    secs = time.time() - t0
    net.load_state_dict(best_state)
    net.eval()
    rep = {"devAP": round(best, 4), "epochs": hist, "seconds": round(secs), "params": sum(p.numel() for p in net.parameters())}
    for S in (va, Split(a.set, "test", schema)):
        X, _ = model_inputs(S.X, cols)
        n_, c_ = prep(X)
        n_ = torch.from_numpy(((n_ - mu) / sd).astype(np.float32))
        for k, c in enumerate(cards):
            c_[:, k] = np.minimum(c_[:, k], c - 1)
        c_ = torch.from_numpy(c_)
        t = time.time()
        with torch.no_grad():
            p = torch.cat([torch.sigmoid(net(n_[b:b + 65536], c_[b:b + 65536])) for b in range(0, len(n_), 65536)]).numpy()
        rep[f"predictSeconds-{S.name}"] = round(time.time() - t, 2)
        np.save(os.path.join(a.out, f"scores-mlp-{S.name}.npy"), p.astype(np.float32))
    json.dump(rep, open(os.path.join(a.out, "train-mlp.json"), "w"), indent=1)
    log(f"done: {json.dumps(rep)}")


if __name__ == "__main__":
    main()
