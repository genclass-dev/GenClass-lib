# Readers of the teachers' answers on the data node.
# - Clef: Vision v1's cached answers (vision/vision_v1/clef_label.py answered(), copied), under VISION_V1/clef/<variant>.
# - OpenAI (gpt-6-luna, luna-img-p3): OUT/oa/luna-img-p3.jsonl from oa_requests.py collect.

import glob
import json
import os

from common import OUT, V1

CLEF_DIR = os.path.join(V1, "clef")


def answered(variant):
    done = {}
    for f in glob.glob(os.path.join(CLEF_DIR, variant, "answers-*.jsonl")):
        with open(f) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue  # a line cut by a kill
                done[r["id"]] = r
    return done


def luna():
    """crop id -> {"verdict": {class: p}, "family": {class: p}}"""
    out = {}
    with open(os.path.join(OUT, "oa", "luna-img-p3.jsonl")) as fh:
        for line in fh:
            r = json.loads(line)
            out[r["id"]] = r
    return out
