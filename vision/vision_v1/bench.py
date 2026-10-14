#!/usr/bin/env python3
# Training throughput of candidate backbones on this CPU node (forward + backward, random data, one process).
#
#   bench.py --threads 80 --batch 128

import argparse
import json
import time

import torch
import torchvision


def build(name):
    if name == "mnv3s":
        return torchvision.models.mobilenet_v3_small(weights=None)
    if name == "mnv3l":
        return torchvision.models.mobilenet_v3_large(weights=None)
    if name == "effb0":
        return torchvision.models.efficientnet_b0(weights=None)
    if name == "r18":
        return torchvision.models.resnet18(weights=None)
    raise ValueError(name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=80)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--models", default="mnv3s,mnv3l,effb0,r18")
    ap.add_argument("--steps", type=int, default=6)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    res = []
    for name in a.models.split(","):
        for bf16 in (False, True):
            for cl in (False, True):
                m = build(name)
                m.train()
                if cl:
                    m = m.to(memory_format=torch.channels_last)
                opt = torch.optim.AdamW(m.parameters(), 1e-4)
                x = torch.randn(a.batch, 3, 128, 224)
                if cl:
                    x = x.contiguous(memory_format=torch.channels_last)
                y = torch.randint(0, 1000, (a.batch,))
                ts = []
                for s in range(a.steps):
                    t0 = time.time()
                    with torch.autocast("cpu", dtype=torch.bfloat16, enabled=bf16):
                        out = m(x)
                        loss = torch.nn.functional.cross_entropy(out.float(), y)
                    opt.zero_grad()
                    loss.backward()
                    opt.step()
                    ts.append(time.time() - t0)
                dt = sorted(ts[2:])[len(ts[2:]) // 2]
                r = {"model": name, "bf16": bf16, "channelsLast": cl, "imgPerS": round(a.batch / dt, 1),
                     "params": sum(p.numel() for p in m.parameters())}
                print(json.dumps(r), flush=True)
                res.append(r)


if __name__ == "__main__":
    main()
