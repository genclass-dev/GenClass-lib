"""Tests of the provenance audit's pure parts (numpy only; no model is trained):

    python3 -m unittest discover -s vision/train -p 'test_*.py'
"""

import unittest

import numpy as np

import provenance as pv


class ProvenanceTest(unittest.TestCase):
    def test_auc_rank(self):
        self.assertEqual(pv.auc_rank([0, 0, 1, 1], [0.1, 0.2, 0.3, 0.4]), 1.0)
        self.assertEqual(pv.auc_rank([1, 1, 0, 0], [0.1, 0.2, 0.3, 0.4]), 0.0)
        self.assertEqual(pv.auc_rank([0, 1, 0, 1], [0.5, 0.5, 0.5, 0.5]), 0.5)
        self.assertAlmostEqual(pv.auc_rank([0, 1, 0, 1, 1], [0.1, 0.2, 0.3, 0.4, 0.3]), 4.5 / 6)
        self.assertIsNone(pv.auc_rank([1, 1], [0.1, 0.2]))
        rng = np.random.default_rng(1)
        y = rng.integers(0, 2, 20000)
        self.assertLess(abs(pv.auc_rank(y, rng.random(20000)) - 0.5), 0.02)

    def test_match_natural_same_key(self):
        rng = np.random.default_rng(2)
        nat_key = np.array([5, 5, 7, 9, 9, 9])
        pos_key = np.array([9, 5, 7, 8, -1, 9])
        m = pv.match_natural(pos_key, nat_key, rng)
        self.assertEqual(m[3], -1)  # no natural row with key 8
        self.assertEqual(m[4], -1)  # unknown view
        for j in (0, 1, 2, 5):
            self.assertEqual(nat_key[m[j]], pos_key[j])
        # draws cover the rows of a key
        many = pv.match_natural(np.full(3000, 9), nat_key, rng)
        self.assertEqual(set(many.tolist()), {3, 4, 5})

    def test_view_keys(self):
        views = {0: {"host": "a", "device": "desktop", "scheme": "light"}, 1: {"host": "a", "device": "desktop", "scheme": "light"},
                 2: {"host": "a", "device": "phone", "scheme": "light"}, 4: {"host": "b", "device": "desktop", "scheme": "light"}}
        k = pv.view_keys(views, 5)
        self.assertEqual(k[0], k[1])
        self.assertNotEqual(k[0], k[2])
        self.assertNotEqual(k[0], k[4])
        self.assertEqual(k[3], -1)


if __name__ == "__main__":
    unittest.main()
