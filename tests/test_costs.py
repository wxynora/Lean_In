from __future__ import annotations

import unittest

from together_watch import (
    merge_analysis_usage,
    record_analysis_usage_event,
    summarize_analysis_cost,
)


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

        self.assertAlmostEqual(summary.amount_usd, 1.003)
        self.assertEqual(summary.provider_calls, 3)
        self.assertEqual(summary.priced_calls, 3)
        self.assertEqual(summary.input_tokens, 220)
        self.assertEqual(summary.output_tokens, 100)
        self.assertTrue(summary.complete)
        self.assertTrue(summary.pricing_complete)
        self.assertEqual(
            set(summary.breakdown),
            {"knowledge_card", "rolling", "timeline_prepass"},
        )

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
        self.assertFalse(summary.pricing_complete)

    def test_terminal_unpriced_search_and_subtitle_calls_are_visible(self) -> None:
        summary = summarize_analysis_cost(
            [
                {
                    "purpose": "knowledge_card",
                    "status": "done",
                    "usage": {"provider_calls": 2, "priced_calls": 1},
                },
                {
                    "purpose": "subtitle_lookup",
                    "status": "failed",
                    "usage": {"provider_calls": 1, "priced_calls": 0},
                },
            ]
        )

        self.assertTrue(summary.complete)
        self.assertFalse(summary.pricing_complete)
        self.assertEqual(summary.provider_calls, 3)
        self.assertEqual(summary.unpriced_calls, 2)
        self.assertEqual(summary.breakdown["subtitle_lookup"]["unpriced_calls"], 1)

    def test_usage_event_is_idempotent(self) -> None:
        usage = {
            "provider_calls": 1,
            "priced_calls": 1,
            "cost_usd": 0.012,
        }
        recorded, created = record_analysis_usage_event(
            {},
            event_key="analysis:1:provider",
            usage=usage,
        )
        repeated, repeated_created = record_analysis_usage_event(
            recorded,
            event_key="analysis:1:provider",
            usage=usage,
        )

        self.assertTrue(created)
        self.assertFalse(repeated_created)
        self.assertEqual(repeated["provider_calls"], 1)
        self.assertAlmostEqual(repeated["cost_usd"], 0.012)


if __name__ == "__main__":
    unittest.main()
