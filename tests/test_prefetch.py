from __future__ import annotations

import unittest

from together_watch import plan_rolling_prefetch


class RollingPrefetchTests(unittest.TestCase):
    def test_prefetches_full_batches_toward_thirty_minutes(self) -> None:
        decision = plan_rolling_prefetch(
            playhead_ms=0,
            next_start_ms=0,
            duration_ms=3_600_000,
            content_end_ms=3_500_000,
        )

        self.assertTrue(decision.should_schedule)
        self.assertEqual(decision.target_until_ms, 1_800_000)
        self.assertEqual(decision.batch_end_ms, 140_000)

    def test_small_playhead_change_does_not_create_a_short_batch(self) -> None:
        waiting = plan_rolling_prefetch(
            playhead_ms=0,
            next_start_ms=1_680_000,
            duration_ms=3_600_000,
            content_end_ms=3_500_000,
        )
        refill = plan_rolling_prefetch(
            playhead_ms=20_000,
            next_start_ms=1_680_000,
            duration_ms=3_600_000,
            content_end_ms=3_500_000,
        )

        self.assertFalse(waiting.should_schedule)
        self.assertEqual(waiting.reason, "coverage_refill_wait")
        self.assertTrue(refill.should_schedule)
        self.assertEqual(refill.batch_end_ms, 1_820_000)

    def test_only_normal_content_end_allows_a_short_final_batch(self) -> None:
        decision = plan_rolling_prefetch(
            playhead_ms=0,
            next_start_ms=1_760_000,
            duration_ms=3_600_000,
            content_end_ms=1_800_000,
        )

        self.assertTrue(decision.should_schedule)
        self.assertEqual(decision.batch_end_ms, 1_800_000)


if __name__ == "__main__":
    unittest.main()
