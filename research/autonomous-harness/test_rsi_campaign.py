import unittest

import model_tools as mt
import rsi_campaign as rc


class CampaignTests(unittest.TestCase):
    def test_exact_candidate_digest_required(self):
        c = rc.make_candidate("typed_compiler")
        request = rc._request(c, "validation", 1, 1)
        request["candidate"]["policy"] = "fixed_dijkstra"
        with self.assertRaisesRegex(ValueError, "candidate digest"):
            rc.evaluate_request(request)

    def test_evaluator_cannot_be_candidate_author(self):
        c = rc.make_candidate("typed_compiler", author_role=rc.EVALUATOR_ROLE)
        with self.assertRaisesRegex(ValueError, "author must differ"):
            rc.evaluate_request(rc._request(c, "validation", 1, 1))

    def test_evaluator_digest_required(self):
        request = rc._request(rc.make_candidate("typed_compiler"), "validation", 1, 1)
        request["evaluator_digest"] = "another-evaluator"
        with self.assertRaisesRegex(ValueError, "evaluator digest"):
            rc.evaluate_request(request)

    def test_campaign_has_frozen_confirmation_and_preserves_active(self):
        result = rc.run_campaign(seed=92077, cases_per_family=1)
        self.assertEqual(result["active_before_digest"], result["active_after_digest"])
        self.assertNotEqual(result["active_before_digest"],
                            result["selection_receipt"]["selected_candidate_digest"])
        self.assertEqual(len({r["corpus_digest"] for r in result["validation"]}), 1)
        self.assertEqual(len({r["corpus_digest"] for r in result["confirmation"]}), 1)
        self.assertNotEqual(result["validation"][0]["corpus_digest"],
                            result["confirmation"][0]["corpus_digest"])
        self.assertTrue(all(r["evaluator_digest"] == result["evaluator_digest"]
                            for r in result["validation"] + result["confirmation"]))
        self.assertTrue(all(r["candidate_author"] != r["evaluator_role"]
                            for r in result["validation"] + result["confirmation"]))
        self.assertFalse(result["decision"]["promotion_performed"])
        self.assertFalse(result["decision"]["strict_gain_over_strong_baseline"])
        self.assertEqual(result["cost_ledger"]["training_jobs"], 0)


if __name__ == "__main__":
    unittest.main()
