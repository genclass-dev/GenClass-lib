import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resolve import resolve, stratum  # noqa: E402


def v(verdict, family="none"):
    return {"verdict": verdict, "family": family}


class ResolveTest(unittest.TestCase):
    def test_single_vote_kept(self):
        self.assertEqual(resolve([v("real", "media")]), ("real", "media", None))

    def test_agreement_kept(self):
        self.assertEqual(resolve([v("not"), v("not")]), ("not", "none", True))
        self.assertEqual(resolve([v("real", "overflow"), v("real", "responsive")]), ("real", "overflow", True))

    def test_disagreement_is_unclear(self):
        self.assertEqual(resolve([v("real", "overflow"), v("not")]), ("unclear", "overflow", False))
        self.assertEqual(resolve([v("not"), v("unclear", "blank")]), ("unclear", "blank", False))
        self.assertEqual(resolve([v("unclear", "motion"), v("unclear", "blank")]), ("unclear", "motion", True))

    def test_stratum_order(self):
        self.assertEqual(stratum(["gbt", "rules"]), "rules")
        self.assertEqual(stratum(["random", "gbt"]), "gbt")
        self.assertEqual(stratum(["random"]), "random")


if __name__ == "__main__":
    unittest.main()
