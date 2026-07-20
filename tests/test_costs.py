from __future__ import annotations

import unittest

from together_watch import merge_analysis_usage, summarize_analysis_cost


class AnalysisCostTests(unittest.TestCase):
    def test_retry_usage_accumulates_without_counting_local_reuse(self) -> None:
        failed = {
            "input_tokens": 100,
            "output_tokens": 40,
            "cost_usd": 0.001,
            "provider_called": True,
            "cost_reported": True,
        }
        retried = {
            "input_tokens": 120,
            "output_tokens": 60,
            "cost_usd": 0.002,
            "provider_called": True,
            "cost_reported": True,
        }
        merged = merge_analysis_usage(failed, retried)
        summary = summarize_analysis_cost(
            [
                {"purpose": "rolling", "status": "done", "usage": merged},
                {
                    "purpose": "timeline_prepass",
                    "status": "done",
                    "usage": {
                        "provider_called": False,
                        "cost_reported": True,
                        "model": "local-fingerprint-reuse",
                    },
                },
                {
                    "purpose": "knowledge_card",
                    "status": "done",
                    "usage": {
                        "cost_usd": 1.0,
                        "provider_called": True,
                        "cost_reported": True,
                    },
                },
            ]
        )

        self.assertAlmostEqual(summary.amount_usd, 0.003)
        self.assertEqual(summary.provider_calls, 2)
        self.assertEqual(summary.priced_calls, 2)
        self.assertEqual(summary.input_tokens, 220)
        self.assertEqual(summary.output_tokens, 100)
        self.assertTrue(summary.complete)

    def test_pending_or_unpriced_calls_make_summary_incomplete(self) -> None:
        summary = summarize_analysis_cost(
            [
                {
                    "purpose": "identify",
                    "status": "running",
                    "usage": {
                        "provider_called": True,
                        "cost_reported": False,
                    },
                }
            ]
        )

        self.assertEqual(summary.amount_usd, 0)
        self.assertEqual(summary.pending_jobs, 1)
        self.assertFalse(summary.complete)


if __name__ == "__main__":
    unittest.main()
