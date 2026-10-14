#!/usr/bin/env python3
# Where a training step's time goes: batch assembly from the packed arrays (memmap or preloaded) against the model's
# forward and backward pass. Prints timings only.

import os
import sys
import time

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train import load_pack, batches, Student  # noqa: E402


def main():
    torch.set_num_threads(78)
    nat, X, Xd, F = load_pack("nat")
    full = np.array([it["src"] == "crawl" for it in nat])
    rng = np.random.default_rng(0)
    order = np.stack([np.zeros(20 * 256, int), rng.integers(0, len(nat), 20 * 256)], 1)
    for name, sets in (("memmap", [("nat", X, Xd, F, full)]),):
        t0 = time.time()
        n = 0
        for x, f, idx in batches(sets, order, 256, rng):
            n += 1
        print(name, "batch assembly %.3f s per batch of 256" % ((time.time() - t0) / n), flush=True)
    t0 = time.time()
    Xr = np.ascontiguousarray(X[: 30000])
    Xdr = np.ascontiguousarray(Xd[: 30000])
    print("preload 30k rows: %.1f s" % (time.time() - t0), flush=True)
    order2 = np.stack([np.zeros(20 * 256, int), rng.integers(0, 30000, 20 * 256)], 1)
    t0 = time.time()
    n = 0
    for x, f, idx in batches([("nat", Xr, Xdr, F[:30000], full[:30000])], order2, 256, rng):
        n += 1
    print("preloaded batch assembly %.3f s per batch" % ((time.time() - t0) / n), flush=True)
    m = Student("mnv3s", pretrained=False).to(memory_format=torch.channels_last)
    opt = torch.optim.AdamW(m.parameters(), 1e-4)
    xb, fb = x, f
    ts = []
    for k in range(8):
        t0 = time.time()
        za, zb, va, vb = m(xb, fb)
        loss = za.float().logsumexp(1).mean() + zb.float().logsumexp(1).mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
        ts.append(time.time() - t0)
    print("model step %.3f s per batch of 256 (median of last 6)" % float(np.median(ts[2:])), flush=True)


if __name__ == "__main__":
    main()
