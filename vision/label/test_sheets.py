"""Tests of label/sheets.py on synthetic crops (no browser, no crawl data):

    python3 -m unittest discover -s vision/label -p 'test_*.py'
"""

import csv
import json
import os
import tempfile
import unittest

from PIL import Image

import sheets


def make_crops(d, n):
    os.makedirs(os.path.join(d, "shard-0", "crops"), exist_ok=True)
    ids = []
    for k in range(n):
        cid = f"c{k:012x}"
        w, h = 60 + 13 * k, 40 + 7 * k
        Image.new("RGB", (w, h), (20 * (k % 12), 120, 200)).save(os.path.join(d, "shard-0", "crops", cid + ".jpg"))
        side = {"id": cid, "file": cid + ".jpg", "vid": "abc-light", "i": k, "sources": ["random"], "inCrop": [24, 24, w - 48, h - 48]}
        json.dump(side, open(os.path.join(d, "shard-0", "crops", cid + ".json"), "w"))
        ids.append(cid)
    # a sidecar without its image is skipped
    json.dump({"id": "c-missing", "file": "c-missing.jpg"}, open(os.path.join(d, "shard-0", "crops", "c-missing.json"), "w"))
    return ids


class SheetsTest(unittest.TestCase):
    def test_layout_and_fit(self):
        self.assertEqual(sheets.layout(14)[:2], [(0, 1), (0, 2)])
        self.assertEqual(sheets.layout(14)[12], (1, 1))
        self.assertEqual(sheets.fit(100, 50, 400, 400), 3.0)
        self.assertAlmostEqual(sheets.fit(1000, 500, 400, 400), 0.4)

    def test_sheets_index_and_csv(self):
        with tempfile.TemporaryDirectory() as d:
            ids = make_crops(d, 14)
            out = os.path.join(d, "label")
            res = sheets.main(["--crops", d, "--out", out, "--seed", "3"])
            self.assertEqual(len(res), 2)
            idx = json.load(open(os.path.join(out, "index.json")))
            self.assertEqual(idx["crops"], 14)
            cells = [c for s in idx["sheets"] for c in s["cells"]]
            self.assertEqual(sorted(c["id"] for c in cells), sorted(ids))
            self.assertEqual([c["cell"] for c in idx["sheets"][0]["cells"]], list(range(1, 13)))
            # blind: the index says where an id is, not which source chose it
            self.assertNotIn("sources", json.dumps(idx))
            im = Image.open(os.path.join(out, "sheet-000.png"))
            self.assertTrue(1380 <= im.width <= 1400, im.width)
            rows = list(csv.reader(open(os.path.join(out, "labels.csv"))))
            self.assertEqual(rows[0], ["id", "sheet", "cell", "label", "note"])
            self.assertEqual(len(rows), 15)
            # the same seed gives the same order
            again = sheets.main(["--crops", d, "--out", os.path.join(d, "label2"), "--seed", "3"])
            self.assertEqual([c["id"] for c in again[0]["cells"]], [c["id"] for c in idx["sheets"][0]["cells"]])

    def test_stratified_selection(self):
        sides = []
        for k in range(30):
            src = ["rules"] if k % 3 == 0 else ["gbt", "random"] if k % 3 == 1 else ["random"]
            sides.append({"id": f"c{k:012x}", "vid": f"v{k % 5:011x}-light", "sources": src})
        got = sheets.select(sides, sheets.parse_quota("rules=4,gbt=3,random=5"), per_view=3)
        strata = [s["_stratum"] for s in got]
        self.assertEqual(strata.count("rules"), 4)
        self.assertEqual(strata.count("gbt"), 3)  # a crop chosen by gbt and random counts for gbt
        self.assertLessEqual(strata.count("random"), 5)
        per = {}
        for s in got:
            per[s["vid"]] = per.get(s["vid"], 0) + 1
        self.assertLessEqual(max(per.values()), 3)
        self.assertEqual(sheets.parse_quota(""), [])

    def test_views_filter(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "views.jsonl.gz")
            import gzip
            with gzip.open(p, "wt") as fh:
                for vid, split, rnd, dup in (("a-light", "val", 0, 0), ("b-light", "train", 0, 0), ("c-light", "test", 0, 1), ("d-light-r1", "test", 1, 0), ("e-dark", "test", 0, 0)):
                    fh.write(json.dumps({"vid": vid, "split": split, "round": rnd, "dup": dup}) + "\n")
            self.assertEqual(sheets.allowed_views(p, {"val", "test"}), {"a-light": "val", "e-dark": "test"})


if __name__ == "__main__":
    unittest.main()
